#!/usr/bin/env tsx
// @ts-nocheck

const {
  cleanupOAuthRefreshLocks,
  resolveOAuthRefreshLockDir,
} = require('../lib/oauth/refresh-lock.ts');

function arg(name) {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find((item) => item === name || item.startsWith(prefix));
  if (!found) return null;
  if (found === name) return true;
  return found.slice(prefix.length);
}

function main() {
  const apply = arg('--apply') === true;
  const confirm = String(arg('--confirm') || '').trim();
  const staleMsRaw = Number(arg('--stale-ms') || process.env.HUB_OAUTH_REFRESH_LOCK_STALE_MS || 180_000);
  const staleMs = Number.isFinite(staleMsRaw) && staleMsRaw > 0 ? staleMsRaw : 180_000;
  const result = cleanupOAuthRefreshLocks({ apply, confirm, staleMs });

  console.log(JSON.stringify({
    ...result,
    lock_dir: resolveOAuthRefreshLockDir(),
    stale_ms: staleMs,
    stale_locks: result.stale_locks.map((lock) => ({
      lock_name: lock.lock_name,
      age_ms: lock.age_ms,
      stale: lock.stale,
      provider: lock.provider,
      profile_id: lock.profile_id,
      reason: lock.reason,
      pid: lock.pid,
      created_at: lock.created_at,
    })),
  }, null, 2));

  process.exitCode = result.ok ? 0 : 1;
}

main();
