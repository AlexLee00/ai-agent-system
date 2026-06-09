#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const hubClientPath = path.join(PROJECT_ROOT, 'packages/core/lib/hub-client');

function loadHubClient() {
  delete require.cache[require.resolve(hubClientPath)];
  return require(hubClientPath);
}

async function main() {
  const originalEnv = {
    USE_HUB_SECRETS: process.env.USE_HUB_SECRETS,
    HUB_BASE_URL: process.env.HUB_BASE_URL,
    HUB_AUTH_TOKEN: process.env.HUB_AUTH_TOKEN,
    HUB_CLIENT_SHARED_SECRET_CACHE_DIR: process.env.HUB_CLIENT_SHARED_SECRET_CACHE_DIR,
    HUB_CLIENT_SHARED_SECRET_STALE_MS: process.env.HUB_CLIENT_SHARED_SECRET_STALE_MS,
    HUB_CLIENT_SHARED_SECRET_CACHE_ENABLED: process.env.HUB_CLIENT_SHARED_SECRET_CACHE_ENABLED,
  };
  const originalFetch = global.fetch;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-client-shared-secret-cache-'));

  try {
    process.env.USE_HUB_SECRETS = 'true';
    process.env.HUB_BASE_URL = 'http://hub-client-shared-secret-cache-smoke.local';
    process.env.HUB_AUTH_TOKEN = 'hub-client-shared-secret-cache-token';
    process.env.HUB_CLIENT_SHARED_SECRET_CACHE_DIR = tmp;
    process.env.HUB_CLIENT_SHARED_SECRET_STALE_MS = '600000';
    process.env.HUB_CLIENT_SHARED_SECRET_CACHE_ENABLED = 'true';

    let fetchCalls = 0;
    global.fetch = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ ok: true, data: { value: 'from-hub' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const firstClient = loadHubClient();
    const first = await firstClient.fetchHubSecrets('config', 1000);
    assert.deepEqual(first, { value: 'from-hub' });
    assert.equal(fetchCalls, 1);

    const cacheFile = fs.readdirSync(tmp).find((name) => name.startsWith('secret-config-'));
    assert.ok(cacheFile, 'shared secret cache file should be written outside the repo');
    const cachePath = path.join(tmp, cacheFile);
    const cachedPayload = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    cachedPayload.expiresAt = Date.now() - 1;
    fs.writeFileSync(cachePath, `${JSON.stringify(cachedPayload)}\n`, { mode: 0o600 });

    global.fetch = async () => {
      fetchCalls += 1;
      return new Response(JSON.stringify({ ok: false, error: 'rate_limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      });
    };

    const secondClient = loadHubClient();
    const stale = await secondClient.fetchHubSecrets('config', 1000);
    assert.deepEqual(stale, { value: 'from-hub' });
    assert.equal(fetchCalls, 2, 'expired shared cache should fall back to stale cache after a 429');

    console.log(JSON.stringify({ ok: true, shared_cache_file: cacheFile, stale_cache_used: true }));
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

main().catch((error) => {
  console.error('[hub-client-shared-secret-cache-smoke] failed:', error?.stack || error?.message || error);
  process.exitCode = 1;
});
