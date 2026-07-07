#!/usr/bin/env node
/**
 * Daily social-media auto-poster (GitHub Actions edition).
 *
 * Flow:
 *   1. GET https://whobettersports.com/api/daily-debate → today's matchup
 *      metadata + comparison verdict
 *   2. Headless Chrome (puppeteer-core against GH Actions' pre-installed
 *      Chrome) loads the comparison page, waits for the ShareCard element
 *      (#share-card-root) to render, then screenshots it
 *   3. Posts the PNG + caption to Bluesky / Threads / Instagram. Missing
 *      tokens fail soft so adding a new platform is just "add a GH secret"
 *
 * Replaces the earlier Cloudflare Worker — same logic, no paid tier needed.
 * Triggered by .github/workflows/social-post.yml on a cron schedule, plus
 * workflow_dispatch for one-off manual fires.
 */

import puppeteer from 'puppeteer-core';

const env = process.env;
const DAILY_DEBATE_URL =
  env.DAILY_DEBATE_URL || 'https://whobettersports.com/api/daily-debate';

async function fetchDailyDebate() {
  const res = await fetch(DAILY_DEBATE_URL, {
    headers: { 'user-agent': 'who-better-social-cron/1.0' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`daily-debate fetch ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

/**
 * Spin up Chrome, navigate to the compare page, wait for the ShareCard
 * element + ESPN data to settle, then screenshot the card at native res.
 * Returns a PNG Buffer.
 */
async function screenshotShareCard(debate) {
  // GH Actions' ubuntu-latest ships Chrome at this path; locally Puppeteer
  // would download its own, but in CI we reuse the runner's binary.
  const browser = await puppeteer.launch({
    executablePath: env.CHROME_PATH || '/usr/bin/google-chrome-stable',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    headless: 'new',
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1400, deviceScaleFactor: 2 });

    // Hit the comparison page with the matchup's params already set.
    const compareUrl = debate.pageUrl;
    // Defense-in-depth: only load URLs on our own domain. The debate
    // payload comes from our own API but it ultimately drives a
    // headless browser navigation, so we re-assert the origin here.
    if (!compareUrl || !compareUrl.startsWith('https://whobettersports.com/')) {
      throw new Error(
        `Refusing to navigate to non-allowlisted URL: ${compareUrl}`
      );
    }
    try {
      await page.goto(compareUrl, { waitUntil: 'networkidle2', timeout: 60_000 });

      // Wait for the ShareCard to mount. It's hidden in a 1x1 offscreen
      // host (cardHost styles in compare.tsx) so we'll lift it out of that
      // clipping container before screenshotting.
      await page.waitForSelector('#share-card-root', { timeout: 30_000 });
    } catch (e) {
      let url = '<unknown>';
      let html = '';
      try { url = page.url(); } catch {}
      try { html = (await page.content()).slice(0, 2000); } catch {}
      throw new Error(
        `screenshotShareCard navigation/selector failed: ${e?.message ?? e}\n` +
        `page.url=${url}\n` +
        `page.content (first 2000 chars)=\n${html}`
      );
    }

    // Two-phase DOM prep:
    //   Phase 1 — lift the card out of its 1×1 offscreen clipping wrapper
    //   so the headshots can fully load at the card's natural size.
    //   Phase 2 — detach the card to be a direct child of <body>, hide
    //   every sibling, and reset body background. Without this,
    //   element.screenshot() captures the viewport REGION of the element's
    //   bounding box, so any compare-page chrome painted in that region
    //   (SportPicker / PlayerPicker / ScopePicker) bleeds into the PNG.
    const brokenImageCount = await page.evaluate(async () => {
      const card = document.getElementById('share-card-root');
      // Phase 1: lift for image loading.
      card.style.position = 'fixed';
      card.style.top = '0';
      card.style.left = '0';
      card.style.zIndex = '99999';
      const host = card.parentElement;
      if (host) {
        host.style.overflow = 'visible';
        host.style.width = 'auto';
        host.style.height = 'auto';
        host.style.position = 'static';
      }
      const imgs = Array.from(card.querySelectorAll('img'));
      await Promise.all(
        imgs.map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise((r) => {
                img.onload = r;
                img.onerror = r;
                setTimeout(r, 5000);
              })
        )
      );
      const broken = imgs.filter((img) => !img.complete || img.naturalWidth === 0).length;
      // Phase 2: isolate so nothing else paints in the screenshot region.
      document.body.appendChild(card);
      Array.from(document.body.children).forEach((child) => {
        if (child !== card) child.style.display = 'none';
      });
      card.style.position = 'static';
      card.style.zIndex = 'auto';
      card.style.transform = 'none';
      document.body.style.margin = '0';
      document.body.style.padding = '0';
      document.body.style.background = '#0b0f14';
      document.documentElement.style.background = '#0b0f14';
      return broken;
    });
    if (brokenImageCount > 0) {
      console.warn(`[social-post] WARN: ${brokenImageCount} broken images in card`);
    }
    // Settle after the DOM rewrite.
    await new Promise((r) => setTimeout(r, 500));

    // Read the score the card actually rendered (nativeID'd in ShareCard) so
    // the caption is built from the SAME numbers as the image — the
    // daily-debate API computes its verdict via a separate code path and can
    // disagree (e.g. a "4-4" caption under a "6-3" card). See verdictFromCard.
    const score = await page.evaluate(() => {
      const l = document.getElementById('sc-left-wins');
      const r = document.getElementById('sc-right-wins');
      const li = l ? parseInt((l.textContent || '').trim(), 10) : NaN;
      const ri = r ? parseInt((r.textContent || '').trim(), 10) : NaN;
      return Number.isFinite(li) && Number.isFinite(ri) ? { leftWins: li, rightWins: ri } : null;
    });

    const card = await page.$('#share-card-root');
    if (!card) throw new Error('Share card not found in DOM');
    const png = await card.screenshot({ type: 'png', omitBackground: false });
    return { png: Buffer.from(png), score };
  } finally {
    await browser.close();
  }
}

/**
 * Build the caption's verdict line from the score the CARD rendered, so the
 * caption can never contradict the image. Mirrors the wording the
 * daily-debate API uses ("X wins A-B" / "Dead even at A-B"). Falls back to the
 * API's own verdict when the card didn't expose a score (e.g. an older deploy
 * without the nativeIDs, or stats unavailable).
 */
function verdictFromCard(debate, score) {
  if (!score) return debate.verdict;
  const { leftWins, rightWins } = score;
  if (leftWins === rightWins) return `Dead even at ${leftWins}-${rightWins}`;
  const name = leftWins > rightWins ? debate.leftLabel : debate.rightLabel;
  const hi = Math.max(leftWins, rightWins);
  const lo = Math.min(leftWins, rightWins);
  return `${name} wins ${hi}-${lo}`;
}

/**
 * Instagram only accepts images with an aspect ratio between 0.8 (4:5
 * portrait) and 1.91 (landscape). A content-rich comparison card renders
 * tall — close to 1:2 (e.g. 1080×2148) — which IG rejects outright with
 * "Invalid Aspect Ratio", so the daily post fails (Threads is lenient and
 * accepts it, which is why only IG was breaking). Pad the PNG with bars in
 * the card's background colour to bring it just inside the range. No-op when
 * the card is already valid; falls back to the raw buffer (rather than
 * crashing) if `sharp` isn't installed.
 */
async function padToSafeAspect(buffer) {
  const MIN = 0.8;
  const MAX = 1.91;
  const BG = '#0b0f14'; // matches the ShareCard background so bars blend in
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch (e) {
    console.warn('[social-post] WARN: sharp unavailable, posting image unpadded:', e?.message ?? e);
    return buffer;
  }
  const { width, height } = await sharp(buffer).metadata();
  if (!width || !height) return buffer;
  const aspect = width / height;
  if (aspect >= MIN && aspect <= MAX) return buffer;
  const targetW = aspect < MIN ? Math.ceil(height * MIN) : width;
  const targetH = aspect > MAX ? Math.ceil(width / MAX) : height;
  const left = Math.floor((targetW - width) / 2);
  const right = targetW - width - left;
  const top = Math.floor((targetH - height) / 2);
  const bottom = targetH - height - top;
  console.log(
    `[social-post] padding ${width}×${height} (aspect ${aspect.toFixed(3)}) → ` +
    `${targetW}×${targetH} so the post is within the 0.8–1.91 aspect range`
  );
  return sharp(buffer).extend({ top, bottom, left, right, background: BG }).png().toBuffer();
}

// ─── Platform posters ─────────────────────────────────────────────────────

async function uploadImage(buffer, fileName) {
  // Bluesky takes binary uploads directly; Threads + Instagram need a
  // public image_url to fetch. catbox.moe blocks GH Actions' shared
  // Azure IP pool (returns 412), and most anonymous file hosts (0x0,
  // tmpfiles, uguu) do the same since CI IPs are constantly abused.
  //
  // Instead: PUT the PNG to a GitHub repo via the Contents API.
  //
  // Required configuration — set IMAGE_REPO (e.g.
  // "jlarkin21/who-better-images") and IMAGE_REPO_TOKEN (a PAT with
  // `contents:write` on the side-repo). We intentionally do NOT fall
  // back to the workflow's GITHUB_TOKEN / GITHUB_REPOSITORY: that path
  // only works when the *main* repo is public, and silently uploading
  // images into the main repo on a misconfig is the wrong default —
  // explicit beats implicit here.
  const token = env.IMAGE_REPO_TOKEN;
  const repo = env.IMAGE_REPO;
  if (!token || !repo) {
    throw new Error('IMAGE_REPO and IMAGE_REPO_TOKEN are required');
  }
  const branch = 'social-posts';
  const path = `${fileName}`;
  const api = `https://api.github.com/repos/${repo}`;
  const auth = { Authorization: `Bearer ${token}`, 'user-agent': 'who-better-social-post/1.0' };

  // Ensure the branch exists. If 404, branch from main.
  const branchRes = await fetch(`${api}/branches/${branch}`, { headers: auth });
  if (branchRes.status === 404) {
    const mainRefRes = await fetch(`${api}/git/refs/heads/main`, { headers: auth });
    if (!mainRefRes.ok) throw new Error(`Could not read main ref: ${mainRefRes.status}`);
    const mainRef = await mainRefRes.json();
    const createRes = await fetch(`${api}/git/refs`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: mainRef.object.sha }),
    });
    if (!createRes.ok) throw new Error(`Could not create ${branch}: ${createRes.status}`);
  } else if (!branchRes.ok) {
    throw new Error(`Could not check branch: ${branchRes.status}`);
  }

  // Look up existing SHA so we can update (Contents API requires it for overwrites).
  // Branch explicitly: 404 = new file (no sha), ok = take existing sha,
  // anything else (401/403/5xx) is a real failure we shouldn't paper over.
  let existingSha;
  const existRes = await fetch(`${api}/contents/${path}?ref=${branch}`, { headers: auth });
  if (existRes.status === 404) {
    // New file — leave existingSha undefined.
  } else if (existRes.ok) {
    const existing = await existRes.json();
    existingSha = existing.sha;
  } else {
    throw new Error(`Could not check existing image (${path}): ${existRes.status}`);
  }

  const putRes = await fetch(`${api}/contents/${path}`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({
      message: `social-post: ${fileName}`,
      content: buffer.toString('base64'),
      branch,
      sha: existingSha,
    }),
  });
  if (!putRes.ok) {
    const err = await putRes.text();
    throw new Error(`GitHub upload ${putRes.status}: ${err}`);
  }

  return `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
}

async function postToBluesky(text, imageBuffer, altText) {
  if (!env.BLUESKY_HANDLE || !env.BLUESKY_APP_PASSWORD) {
    return { ok: false, error: 'not configured (Bluesky)' };
  }
  const sessionRes = await fetch('https://bsky.social/xrpc/com.atproto.server.createSession', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      identifier: env.BLUESKY_HANDLE,
      password: env.BLUESKY_APP_PASSWORD,
    }),
  });
  if (!sessionRes.ok) return { ok: false, error: `Bluesky login ${sessionRes.status}` };
  const sessionBody = await sessionRes.json();
  const { accessJwt, did } = sessionBody;
  if (!accessJwt || !did) {
    return {
      ok: false,
      error:
        'Bluesky createSession returned no accessJwt/did: ' +
        JSON.stringify(sessionBody).slice(0, 300),
    };
  }

  const blobRes = await fetch('https://bsky.social/xrpc/com.atproto.repo.uploadBlob', {
    method: 'POST',
    headers: { 'content-type': 'image/png', authorization: `Bearer ${accessJwt}` },
    body: imageBuffer,
  });
  if (!blobRes.ok) return { ok: false, error: `Bluesky blob ${blobRes.status}` };
  const blobBody = await blobRes.json();
  const { blob } = blobBody;
  if (!blob) {
    return {
      ok: false,
      error:
        'Bluesky uploadBlob returned no blob: ' +
        JSON.stringify(blobBody).slice(0, 300),
    };
  }

  const record = {
    $type: 'app.bsky.feed.post',
    text,
    createdAt: new Date().toISOString(),
    embed: {
      $type: 'app.bsky.embed.images',
      images: [{ alt: altText, image: blob }],
    },
  };
  const postRes = await fetch('https://bsky.social/xrpc/com.atproto.repo.createRecord', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessJwt}` },
    body: JSON.stringify({ repo: did, collection: 'app.bsky.feed.post', record }),
  });
  if (!postRes.ok) return { ok: false, error: `Bluesky post ${postRes.status}` };
  const postBody = await postRes.json();
  const { uri } = postBody;
  if (!uri) {
    return {
      ok: false,
      error:
        'Bluesky createRecord returned no uri: ' +
        JSON.stringify(postBody).slice(0, 300),
    };
  }
  return { ok: true, postUri: uri };
}

/** Surface Meta's actual error body (often has a clear `error.message`)
 *  on top of the HTTP status, so diagnosis doesn't require re-running. */
async function metaErr(res, label) {
  let body = '';
  try {
    body = (await res.text()).slice(0, 500);
  } catch (e) {
    body = '<failed to read body: ' + (e?.message ?? e) + '>';
  }
  return `${label} ${res.status}: ${body}`;
}

/** POST to Meta (Threads + IG) with a retry on TRANSIENT failures. Meta's
 *  container/publish endpoints intermittently return a 5xx OAuthException with
 *  `"is_transient": true` and the message "Please retry your request later" — a
 *  single attempt meant one Meta hiccup dropped the daily post on Threads + IG
 *  (Bluesky still went out) and failed the whole job. Retry those with
 *  exponential backoff; non-transient errors (bad token, bad image_url) fail
 *  fast so we don't mask real misconfig. Returns the final Response so callers
 *  keep their existing `res.ok` / metaErr() handling. */
async function metaFetch(url, init, label, retries = 3) {
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url, init);
    if (res.ok || attempt >= retries) return res;
    // Clone to peek the body without consuming it — the caller still reads the
    // original via metaErr() on the final failure.
    let transient = res.status >= 500;
    try {
      if (/"is_transient"\s*:\s*true/.test(await res.clone().text())) transient = true;
    } catch { /* body unreadable — fall back to the status-code check */ }
    if (!transient) return res;
    const waitMs = 3000 * 2 ** attempt; // 3s, 6s, 12s
    console.warn(`[social-post] ${label} transient ${res.status} — retry ${attempt + 1}/${retries} in ${waitMs}ms`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

async function postToThreads(text, imageUrl) {
  if (!env.THREADS_USER_ID || !env.THREADS_ACCESS_TOKEN) {
    return { ok: false, error: 'not configured (Threads)' };
  }
  const base = 'https://graph.threads.net/v1.0';
  const containerRes = await metaFetch(`${base}/${env.THREADS_USER_ID}/threads`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      media_type: 'IMAGE', image_url: imageUrl, text,
      access_token: env.THREADS_ACCESS_TOKEN,
    }).toString(),
  }, 'Threads container');
  if (!containerRes.ok) return { ok: false, error: await metaErr(containerRes, 'Threads container') };
  const containerBody = await containerRes.json();
  const { id: creationId } = containerBody;
  if (!creationId) {
    return {
      ok: false,
      error:
        'Threads container returned no id: ' +
        JSON.stringify(containerBody).slice(0, 300),
    };
  }

  await new Promise((r) => setTimeout(r, 2000));

  const publishRes = await metaFetch(`${base}/${env.THREADS_USER_ID}/threads_publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      creation_id: creationId,
      access_token: env.THREADS_ACCESS_TOKEN,
    }).toString(),
  }, 'Threads publish');
  if (!publishRes.ok) return { ok: false, error: await metaErr(publishRes, 'Threads publish') };
  const publishBody = await publishRes.json();
  const { id: postId } = publishBody;
  if (!postId) {
    return {
      ok: false,
      error:
        'Threads publish returned no id: ' +
        JSON.stringify(publishBody).slice(0, 300),
    };
  }
  return { ok: true, postId };
}

async function postToInstagram(caption, imageUrl) {
  if (!env.INSTAGRAM_USER_ID || !env.INSTAGRAM_ACCESS_TOKEN) {
    return { ok: false, error: 'not configured (Instagram)' };
  }
  const base = 'https://graph.instagram.com/v18.0';
  const containerRes = await metaFetch(`${base}/${env.INSTAGRAM_USER_ID}/media`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      image_url: imageUrl, caption,
      access_token: env.INSTAGRAM_ACCESS_TOKEN,
    }).toString(),
  }, 'IG container');
  if (!containerRes.ok) return { ok: false, error: await metaErr(containerRes, 'IG container') };
  const containerBody = await containerRes.json();
  const { id: creationId } = containerBody;
  if (!creationId) {
    return {
      ok: false,
      error:
        'IG container returned no id: ' +
        JSON.stringify(containerBody).slice(0, 300),
    };
  }

  await new Promise((r) => setTimeout(r, 2000));

  const publishRes = await metaFetch(`${base}/${env.INSTAGRAM_USER_ID}/media_publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      creation_id: creationId,
      access_token: env.INSTAGRAM_ACCESS_TOKEN,
    }).toString(),
  }, 'IG publish');
  if (!publishRes.ok) return { ok: false, error: await metaErr(publishRes, 'IG publish') };
  const publishBody = await publishRes.json();
  const { id: postId } = publishBody;
  if (!postId) {
    return {
      ok: false,
      error:
        'IG publish returned no id: ' +
        JSON.stringify(publishBody).slice(0, 300),
    };
  }
  return { ok: true, postId };
}

// ─── Captions ─────────────────────────────────────────────────────────────

const SPORT_HASHTAGS = {
  nba:    { discovery: ['#NBA', '#basketball', '#GOATdebate'], twitterStyle: ['#NBAtwitter'] },
  wnba:   { discovery: ['#WNBA', '#womensbasketball'],         twitterStyle: [] },
  nfl:    { discovery: ['#NFL', '#football'],                  twitterStyle: ['#NFLtwitter'] },
  mlb:    { discovery: ['#MLB', '#baseball'],                  twitterStyle: [] },
  soccer: { discovery: ['#WorldCup2026', '#FIFAWorldCup', '#football'], twitterStyle: [] },
};

const tagsFor = (sport, includeTwitter) => {
  const t = SPORT_HASHTAGS[sport];
  if (!t) return '';
  return includeTwitter ? [...t.discovery, ...t.twitterStyle].join(' ') : t.discovery.join(' ');
};

// A hashtag for one team/player label: strip accents + punctuation, drop a
// trailing Jr/Sr/III suffix, and tag the distinctive last word — a player's
// surname or a team's nickname/nation. "Kylian Mbappé" → #Mbappe, "Norway" →
// #Norway, "New York Yankees" → #Yankees.
const NAME_SUFFIX = new Set(['jr', 'sr', 'ii', 'iii', 'iv']);
const participantTag = (label) => {
  const words = (label || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z\s]/g, ' ').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && NAME_SUFFIX.has(words[words.length - 1].toLowerCase())) words.pop();
  const key = words[words.length - 1] || '';
  return key ? `#${key}` : '';
};
// Both sides' tags, e.g. "#Norway #England" or "#Messi #Mbappe".
const participantTags = (d) =>
  [participantTag(d.leftLabel), participantTag(d.rightLabel)].filter(Boolean).join(' ');

const verdictLine = (d) => (d.verdict ? `\nThe stats say: ${d.verdict}.\n` : '');

const captionShort = (d) => {
  const base = `Today's debate: ${d.leftLabel} vs ${d.rightLabel}.\n\n${d.hook}\n${verdictLine(d)}\nSettle it → ${d.pageUrl}`;
  const withTags = `${base}\n\n${participantTags(d)}`;
  // Bluesky caps a post at 300 graphemes — keep the tags only if they fit.
  return withTags.length <= 300 ? withTags : base;
};

const captionMedium = (d) =>
  `Today's debate: ${d.leftLabel} vs ${d.rightLabel}.\n\n${d.hook}\n${verdictLine(d)}\nSettle it with real stats → ${d.pageUrl}\n\n${participantTags(d)} ${tagsFor(d.sport, true)}`.trim();

const captionLong = (d) =>
  `Today's debate: ${d.leftLabel} vs ${d.rightLabel}.\n\n${d.hook}\n${verdictLine(d)}\nReal stats, real verdict — link in bio.\nDrop your pick in the comments.\n\n#WhoBetter #sportsdebate ${participantTags(d)} ${tagsFor(d.sport, false)}`.trim();

const altTextFor = (d) =>
  `Side-by-side stat comparison card: ${d.leftLabel} vs ${d.rightLabel}.`;

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log('[social-post] fetching daily debate…');
  const debate = await fetchDailyDebate();
  console.log(`[social-post] matchup: ${debate.leftLabel} vs ${debate.rightLabel}`);

  console.log('[social-post] screenshotting ShareCard…');
  const { png: rawPng, score } = await screenshotShareCard(debate);
  // Pad tall comparison cards into Instagram's accepted aspect-ratio range —
  // a ~1:2 card otherwise fails IG with "Invalid Aspect Ratio". Threads /
  // Bluesky accept the padded image fine, so one image serves all three.
  const png = await padToSafeAspect(rawPng);
  console.log(`[social-post] PNG ${png.byteLength} bytes`);
  if (score) console.log(`[social-post] card score: ${score.leftWins}-${score.rightWins}`);
  // Caption from the card's own score so the words match the picture.
  const captionDebate = { ...debate, verdict: verdictFromCard(debate, score) };

  // Per-day filename so each post has a stable, unique URL — no jsdelivr
  // / CDN cache collisions if a later run overwrites the same path.
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const fileName = `posts/${today}-${debate.id}.png`;
  console.log(`[social-post] uploading PNG to repo branch → ${fileName}`);
  const imageUrl = await uploadImage(png, fileName);
  console.log(`[social-post] uploaded → ${imageUrl}`);

  // Pre-flight: wait for the uploaded URL to become publicly fetchable.
  // raw.githubusercontent.com's CDN routinely lags 30–90s behind a fresh push
  // (a brand-new file 404s to anonymous requests until it propagates), so poll
  // with backoff instead of giving up on the first miss. NON-FATAL: Bluesky
  // posts from the in-memory blob and never touches this URL, so a slow/blocked
  // CDN must not abort the whole run — only Threads/IG fetch the URL, and the
  // Promise.allSettled below already isolates their failures. (A persistent
  // 404 here usually means IMAGE_REPO is a PRIVATE repo.)
  let imagePublic = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const head = await fetch(imageUrl, { method: 'HEAD' });
      if (head.ok) { imagePublic = true; break; }
    } catch {
      // network blip — fall through to backoff + retry
    }
    await new Promise((r) => setTimeout(r, 5000 * (attempt + 1))); // 5s,10s,…,30s
  }
  if (!imagePublic) {
    console.warn(
      `[social-post] WARN: image URL still not publicly fetchable after retries ` +
      `(${imageUrl}). Bluesky will still post from the blob; Threads/IG may fail ` +
      `to fetch it. If this persists, confirm IMAGE_REPO is a PUBLIC repo.`
    );
  }

  const alt = altTextFor(debate);
  // Use allSettled so one poster throwing (e.g. fetch network error) doesn't
  // cancel the others — we still want the summary log + exit-code logic to
  // run with each platform's true result.
  const settled = await Promise.allSettled([
    postToBluesky(captionShort(captionDebate), png, alt),
    postToThreads(captionMedium(captionDebate), imageUrl),
    postToInstagram(captionLong(captionDebate), imageUrl),
  ]);
  const [blue, threads, ig] = settled.map((r) =>
    r.status === 'fulfilled'
      ? r.value
      : { ok: false, error: r.reason?.message ?? String(r.reason) }
  );

  const summary = {
    debateId: debate.id,
    matchup: `${debate.leftLabel} vs ${debate.rightLabel}`,
    image: imageUrl,
    bluesky: blue,
    threads,
    instagram: ig,
  };
  console.log('[social-post]', JSON.stringify(summary, null, 2));

  // Classify each platform: real failure vs. "not configured" (neutral).
  // Missing-creds errors all start with the literal string "not configured"
  // (see each poster above). Anything else is a genuine API/network
  // failure that should fail the workflow.
  //
  // We also emit a GH Actions ::error:: annotation per real failure so
  // the job summary turns red even when other platforms succeeded.
  const platforms = [
    { name: 'bluesky', result: blue },
    { name: 'threads', result: threads },
    { name: 'instagram', result: ig },
  ];
  let realFailures = 0;
  for (const { name, result } of platforms) {
    if (result.ok) continue;
    const err = typeof result.error === 'string' ? result.error : String(result.error ?? '');
    if (err.startsWith('not configured')) {
      // Neutral skip — creds missing, not a real failure.
      continue;
    }
    realFailures++;
    // GitHub Actions error annotation — surfaces in the job summary UI.
    const escaped = err.replace(/\r?\n/g, ' ');
    console.log(`::error title=social-post ${name} failed::${escaped}`);
  }
  if (realFailures > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[social-post] fatal:', e);
  process.exit(1);
});
