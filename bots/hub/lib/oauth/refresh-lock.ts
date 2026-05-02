const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const env = require('../../../../packages/core/lib/env');

const DEFAULT_LOCK_TIMEOUT_MS = 120_000;
const DEFAULT_LOCK_STALE_MS = 180_000;
const DEFAULT_LOCK_RETRY_MS = 150;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeLockName(provider, profileId) {
  const hash = crypto.createHash('sha256');
  hash.update(String(provider || ''), 'utf8');
  hash.update('\0', 'utf8');
  hash.update(String(profileId || provider || ''), 'utf8');
  return `sha256-${hash.digest('hex')}`;
}

function resolveOAuthRefreshLockDir() {
  return process.env.HUB_OAUTH_REFRESH_LOCK_DIR
    || path.join(env.PROJECT_ROOT, 'bots', 'hub', 'output', 'oauth', 'locks');
}

function resolveOAuthRefreshLockPath(provider, profileId = provider) {
  return path.join(resolveOAuthRefreshLockDir(), safeLockName(provider, profileId));
}

function lockIsStale(lockPath, staleMs) {
  try {
    const stat = fs.statSync(lockPath);
    return Date.now() - stat.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

function writeLockMetadata(lockPath, metadata) {
  try {
    fs.writeFileSync(
      path.join(lockPath, 'owner.json'),
      `${JSON.stringify({
        pid: process.pid,
        created_at: new Date().toISOString(),
        ...metadata,
      }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch {
    // Metadata is diagnostic only; lock ownership is the directory itself.
  }
}

function readLockMetadata(lockPath) {
  try {
    return JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
  } catch {
    return {};
  }
}

function listOAuthRefreshLocks(options = {}) {
  const lockDir = options.lockDir || resolveOAuthRefreshLockDir();
  const staleMs = Number(process.env.HUB_OAUTH_REFRESH_LOCK_STALE_MS || options.staleMs || DEFAULT_LOCK_STALE_MS);
  if (!fs.existsSync(lockDir)) return [];

  return fs.readdirSync(lockDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const lockPath = path.join(lockDir, entry.name);
      let mtimeMs = 0;
      try {
        mtimeMs = fs.statSync(lockPath).mtimeMs;
      } catch {
        mtimeMs = 0;
      }
      const ageMs = mtimeMs > 0 ? Date.now() - mtimeMs : null;
      const metadata = readLockMetadata(lockPath);
      return {
        lock_name: entry.name,
        lock_path: lockPath,
        age_ms: ageMs,
        stale: Number.isFinite(Number(ageMs)) ? Number(ageMs) > staleMs : false,
        provider: metadata.provider || null,
        profile_id: metadata.profile_id || null,
        reason: metadata.reason || null,
        pid: metadata.pid || null,
        created_at: metadata.created_at || null,
      };
    });
}

function cleanupOAuthRefreshLocks(options = {}) {
  const staleLocks = listOAuthRefreshLocks(options).filter((lock) => lock.stale);
  const apply = options.apply === true;
  const confirm = String(options.confirm || '').trim();
  const removed = [];
  if (apply) {
    if (confirm !== 'hub-oauth-lock-janitor') {
      return {
        ok: false,
        dry_run: false,
        error: 'confirm_required',
        stale_count: staleLocks.length,
        removed,
        stale_locks: staleLocks,
      };
    }
    for (const lock of staleLocks) {
      try {
        fs.rmSync(lock.lock_path, { recursive: true, force: true });
        removed.push(lock.lock_name);
      } catch {
        // Keep best-effort semantics; remaining stale locks stay visible.
      }
    }
  }

  return {
    ok: true,
    dry_run: !apply,
    stale_count: staleLocks.length,
    removed,
    stale_locks: staleLocks,
  };
}

async function acquireOAuthRefreshLock(provider, options = {}) {
  const profileId = options.profileId || provider;
  const lockPath = resolveOAuthRefreshLockPath(provider, profileId);
  const timeoutMs = Number(process.env.HUB_OAUTH_REFRESH_LOCK_TIMEOUT_MS || options.timeoutMs || DEFAULT_LOCK_TIMEOUT_MS);
  const staleMs = Number(process.env.HUB_OAUTH_REFRESH_LOCK_STALE_MS || options.staleMs || DEFAULT_LOCK_STALE_MS);
  const retryMs = Number(process.env.HUB_OAUTH_REFRESH_LOCK_RETRY_MS || options.retryMs || DEFAULT_LOCK_RETRY_MS);
  const started = Date.now();

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      writeLockMetadata(lockPath, {
        provider,
        profile_id: profileId,
        reason: options.reason || null,
      });
      return {
        lockPath,
        release() {
          try {
            fs.rmSync(lockPath, { recursive: true, force: true });
          } catch {
            // Best effort cleanup; stale lock detection handles leftovers.
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (lockIsStale(lockPath, staleMs)) {
        try {
          fs.rmSync(lockPath, { recursive: true, force: true });
        } catch {
          // Another process may have reclaimed it first.
        }
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        const timeoutError = new Error(`oauth_refresh_lock_timeout:${provider}`);
        timeoutError.code = 'oauth_refresh_lock_timeout';
        timeoutError.lockPath = lockPath;
        timeoutError.provider = provider;
        throw timeoutError;
      }
      await sleep(Number.isFinite(retryMs) && retryMs > 0 ? retryMs : DEFAULT_LOCK_RETRY_MS);
    }
  }
}

async function withOAuthRefreshLock(provider, reason, work, options = {}) {
  const lock = await acquireOAuthRefreshLock(provider, { ...options, reason });
  try {
    return await work();
  } finally {
    lock.release();
  }
}

module.exports = {
  acquireOAuthRefreshLock,
  cleanupOAuthRefreshLocks,
  listOAuthRefreshLocks,
  resolveOAuthRefreshLockDir,
  resolveOAuthRefreshLockPath,
  withOAuthRefreshLock,
};
