#!/usr/bin/env node
/**
 * Weekly Meta long-lived token refresher (GitHub Actions edition).
 *
 * Threads + Instagram long-lived tokens live ~60 days. Both platforms
 * expose a refresh endpoint that accepts a token at least 24h old and
 * returns a fresh ~60-day token. Running this on a weekly cron keeps
 * the secrets perpetually fresh without manual rotation.
 *
 * Flow per platform:
 *   1. GET refresh_access_token with the current token
 *   2. On success, write the new token back into the repo's GH Actions
 *      secrets via the REST API (libsodium sealed_box, since GitHub's
 *      Secrets API only accepts encrypted values)
 *
 * Each platform is independent — a failure on one doesn't block the
 * other. Missing tokens log "skipped" and continue. Exit code 1 only
 * if at least one CONFIGURED platform failed, so an unconfigured
 * platform never red-X's the workflow.
 *
 * Triggered by .github/workflows/token-refresh.yml on a weekly cron,
 * plus workflow_dispatch for one-off manual refreshes.
 */

import sodium from 'libsodium-wrappers';

const env = process.env;

const PLATFORMS = [
  {
    name: 'Threads',
    secretName: 'THREADS_ACCESS_TOKEN',
    token: env.THREADS_ACCESS_TOKEN,
    refreshUrl: (token) =>
      `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(token)}`,
  },
  {
    name: 'Instagram',
    secretName: 'INSTAGRAM_ACCESS_TOKEN',
    token: env.INSTAGRAM_ACCESS_TOKEN,
    refreshUrl: (token) =>
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token)}`,
  },
];

/** Surface Meta's actual error body on top of the HTTP status. */
async function metaErr(res, label) {
  let body = '';
  try { body = (await res.text()).slice(0, 500); } catch {}
  return `${label} ${res.status}: ${body}`;
}

async function refreshToken(platform) {
  const res = await fetch(platform.refreshUrl(platform.token), {
    headers: { 'user-agent': 'who-better-token-refresh/1.0' },
  });
  if (!res.ok) {
    throw new Error(await metaErr(res, `${platform.name} refresh`));
  }
  const body = await res.json();
  if (!body.access_token) {
    throw new Error(`${platform.name} refresh: response missing access_token`);
  }
  return { accessToken: body.access_token, expiresIn: body.expires_in };
}

/**
 * Encrypt a secret value with the repo's public key using libsodium
 * sealed_box, which is what the GitHub Secrets API requires. Returns
 * the base64-encoded ciphertext.
 */
function encryptForGithub(plaintext, base64PublicKey) {
  const publicKey = sodium.from_base64(base64PublicKey, sodium.base64_variants.ORIGINAL);
  const messageBytes = sodium.from_string(plaintext);
  const sealed = sodium.crypto_box_seal(messageBytes, publicKey);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

/**
 * Write a secret value into the repo's GH Actions secrets. Requires
 * SECRETS_UPDATE_TOKEN (a PAT with actions/secrets:write) — the
 * auto-provisioned GITHUB_TOKEN does NOT have that scope.
 */
async function writeRepoSecret(secretName, secretValue) {
  const token = env.SECRETS_UPDATE_TOKEN;
  const repo = env.GITHUB_REPOSITORY;
  if (!token) throw new Error('SECRETS_UPDATE_TOKEN not set');
  if (!repo) throw new Error('GITHUB_REPOSITORY not set');

  const api = `https://api.github.com/repos/${repo}`;
  const auth = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'user-agent': 'who-better-token-refresh/1.0',
  };

  // 1. Fetch the repo's public key (used for sealed_box encryption).
  const keyRes = await fetch(`${api}/actions/secrets/public-key`, { headers: auth });
  if (!keyRes.ok) {
    const body = await keyRes.text().catch(() => '');
    throw new Error(`Get public-key ${keyRes.status}: ${body.slice(0, 500)}`);
  }
  const { key, key_id } = await keyRes.json();

  // 2. Encrypt the new token value with that key.
  const encrypted_value = encryptForGithub(secretValue, key);

  // 3. PUT the encrypted value to the named secret.
  const putRes = await fetch(`${api}/actions/secrets/${secretName}`, {
    method: 'PUT',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ encrypted_value, key_id }),
  });
  if (!putRes.ok) {
    const body = await putRes.text().catch(() => '');
    throw new Error(`Put secret ${putRes.status}: ${body.slice(0, 500)}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  // libsodium has an async init step that must complete before any
  // crypto_* calls.
  await sodium.ready;

  let anyFailed = false;
  const results = [];

  for (const platform of PLATFORMS) {
    if (!platform.token) {
      console.log(`[token-refresh] ${platform.name} skipped (not configured)`);
      results.push({ platform: platform.name, status: 'skipped' });
      continue;
    }

    try {
      console.log(`[token-refresh] ${platform.name} refreshing…`);
      const { accessToken, expiresIn } = await refreshToken(platform);
      const days = expiresIn ? Math.round(expiresIn / 86400) : '?';
      console.log(`[token-refresh] ${platform.name} new token good for ~${days} days`);

      console.log(`[token-refresh] ${platform.name} writing → ${platform.secretName}`);
      await writeRepoSecret(platform.secretName, accessToken);
      console.log(`[token-refresh] ${platform.name} secret updated`);
      results.push({ platform: platform.name, status: 'ok', expiresIn });
    } catch (e) {
      anyFailed = true;
      const msg = e?.message ?? String(e);
      console.error(`[token-refresh] ${platform.name} FAILED: ${msg}`);
      results.push({ platform: platform.name, status: 'failed', error: msg });
    }
  }

  console.log('[token-refresh]', JSON.stringify(results, null, 2));
  if (anyFailed) process.exit(1);
}

main().catch((e) => {
  console.error('[token-refresh] fatal:', e);
  process.exit(1);
});
