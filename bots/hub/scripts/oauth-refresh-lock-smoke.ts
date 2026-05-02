#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-oauth-refresh-lock-'));
process.env.HUB_OAUTH_REFRESH_LOCK_DIR = path.join(tmpDir, 'locks');
process.env.HUB_OAUTH_REFRESH_LOCK_TIMEOUT_MS = '5000';
process.env.HUB_OAUTH_REFRESH_LOCK_STALE_MS = '60000';
process.env.HUB_OAUTH_REFRESH_LOCK_RETRY_MS = '10';

const {
  resolveOAuthRefreshLockPath,
  withOAuthRefreshLock,
} = require('../lib/oauth/refresh-lock.ts');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const lockPath = resolveOAuthRefreshLockPath('openai-codex-oauth', 'openai-codex-oauth');
  assert.ok(lockPath.startsWith(process.env.HUB_OAUTH_REFRESH_LOCK_DIR), 'lock path must live under configured lock dir');
  assert.ok(!lockPath.includes('openai-codex-oauth'), 'lock path must hash provider/profile instead of using raw ids');

  let active = 0;
  let maxActive = 0;
  const results = await Promise.all(Array.from({ length: 5 }, (_, index) =>
    withOAuthRefreshLock('openai-codex-oauth', `smoke_${index}`, async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(25);
      active -= 1;
      return index;
    })));

  assert.deepEqual(results.sort((a, b) => a - b), [0, 1, 2, 3, 4], 'all lock waiters must complete');
  assert.equal(maxActive, 1, 'same-provider OAuth refresh work must be serialized');
  assert.equal(fs.existsSync(lockPath), false, 'lock directory must be removed after release');

  console.log(JSON.stringify({
    ok: true,
    serialized: true,
    waiters: results.length,
  }));
}

main().catch((error) => {
  console.error('[oauth-refresh-lock-smoke] failed:', error?.message || error);
  process.exit(1);
});
