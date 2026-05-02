#!/usr/bin/env tsx
// @ts-nocheck

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-oauth-lock-janitor-'));
process.env.HUB_OAUTH_REFRESH_LOCK_DIR = path.join(tmpDir, 'locks');
process.env.HUB_OAUTH_REFRESH_LOCK_STALE_MS = '1000';

const {
  cleanupOAuthRefreshLocks,
  resolveOAuthRefreshLockPath,
} = require('../lib/oauth/refresh-lock.ts');

function makeStaleLock(provider) {
  const lockPath = resolveOAuthRefreshLockPath(provider, provider);
  fs.mkdirSync(lockPath, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
    provider,
    profile_id: provider,
    reason: 'smoke',
    pid: 12345,
    created_at: '2026-01-01T00:00:00.000Z',
  }));
  const staleDate = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, staleDate, staleDate);
  return lockPath;
}

const lockPath = makeStaleLock('gemini-cli-oauth');
const dryRun = cleanupOAuthRefreshLocks({ staleMs: 1000 });
assert.equal(dryRun.ok, true);
assert.equal(dryRun.dry_run, true);
assert.equal(dryRun.stale_count, 1);
assert.equal(fs.existsSync(lockPath), true, 'dry-run must not remove stale lock');

const rejected = cleanupOAuthRefreshLocks({ apply: true, confirm: 'wrong', staleMs: 1000 });
assert.equal(rejected.ok, false);
assert.equal(rejected.error, 'confirm_required');
assert.equal(fs.existsSync(lockPath), true, 'apply without exact confirm must not remove stale lock');

const applied = cleanupOAuthRefreshLocks({ apply: true, confirm: 'hub-oauth-lock-janitor', staleMs: 1000 });
assert.equal(applied.ok, true);
assert.equal(applied.removed.length, 1);
assert.equal(fs.existsSync(lockPath), false, 'confirmed apply must remove stale lock');

console.log(JSON.stringify({
  ok: true,
  dry_run_preserved: true,
  confirm_required: true,
  apply_removed: true,
}));
