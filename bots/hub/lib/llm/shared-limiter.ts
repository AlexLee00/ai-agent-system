const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function parseEnvNumber(name, fallback, minValue) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minValue, Math.floor(parsed));
}

function enabledFlag(name, fallback = true) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

const DEFAULT_LOCAL_LIMIT = parseEnvNumber('HUB_LLM_MAX_IN_FLIGHT', 16, 1);
const DEFAULT_LEASE_TTL_MS = parseEnvNumber('HUB_LLM_SHARED_LEASE_TTL_MS', 60_000, 1_000);
const DEFAULT_RETRY_AFTER_MS = parseEnvNumber('HUB_LLM_RETRY_AFTER_MS', 1_000, 200);
const LIMITER_DIR = process.env.HUB_LLM_SHARED_LIMITER_DIR
  || path.join(os.tmpdir(), 'ai-agent-system-hub-llm-limiter');

function sanitizeScope(raw) {
  const value = String(raw || 'unknown').trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_');
  return value || 'unknown';
}

function scopeDir(scope) {
  return path.join(LIMITER_DIR, sanitizeScope(scope));
}

function ensureScopeDir(scope) {
  const dir = scopeDir(scope);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function pruneStaleLeases(dir, now = Date.now()) {
  let pruned = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.lease')) continue;
    const file = path.join(dir, entry.name);
    const payload = safeReadJson(file);
    const expiresAt = Number(payload?.expiresAt || 0);
    if (!expiresAt || expiresAt <= now) {
      try {
        fs.unlinkSync(file);
        pruned += 1;
      } catch {
        // Another process may have removed it first.
      }
    }
  }
  return pruned;
}

function countLeases(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.lease')).length;
  } catch {
    return 0;
  }
}

function acquireScopeLease(scope, limit, now = Date.now()) {
  const dir = ensureScopeDir(scope);
  pruneStaleLeases(dir, now);
  for (let index = 0; index < limit; index += 1) {
    const file = path.join(dir, `${index}.lease`);
    try {
      const fd = fs.openSync(file, 'wx');
      const payload = {
        scope,
        pid: process.pid,
        createdAt: now,
        expiresAt: now + DEFAULT_LEASE_TTL_MS,
      };
      fs.writeFileSync(fd, JSON.stringify(payload));
      fs.closeSync(fd);
      return {
        ok: true,
        scope,
        limit,
        file,
        release() {
          try {
            fs.unlinkSync(file);
          } catch {
            // Release is best-effort; stale lease pruning handles leftovers.
          }
        },
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return {
          ok: false,
          scope,
          limit,
          reason: 'shared_limiter_io_error',
          error: error.message,
          retryAfterMs: DEFAULT_RETRY_AFTER_MS,
        };
      }
    }
  }
  return {
    ok: false,
    scope,
    limit,
    reason: 'shared_limiter_full',
    inFlight: countLeases(dir),
    retryAfterMs: DEFAULT_RETRY_AFTER_MS,
  };
}

async function acquireSharedLimiterLease(identity = {}) {
  if (!enabledFlag('HUB_LLM_SHARED_LIMITER_ENABLED', true)) {
    return {
      ok: true,
      skipped: true,
      scopes: [],
      release() {},
    };
  }

  const team = sanitizeScope(identity.team || 'unknown');
  const provider = sanitizeScope(identity.provider || '');
  const globalLimit = parseEnvNumber('HUB_LLM_SHARED_MAX_IN_FLIGHT', DEFAULT_LOCAL_LIMIT, 1);
  const teamLimit = parseEnvNumber('HUB_LLM_SHARED_TEAM_MAX_IN_FLIGHT', DEFAULT_LOCAL_LIMIT, 1);
  const providerLimit = parseEnvNumber('HUB_LLM_SHARED_PROVIDER_MAX_IN_FLIGHT', DEFAULT_LOCAL_LIMIT, 1);
  const scopes = [
    { scope: 'global', limit: globalLimit },
    { scope: `team:${team}`, limit: teamLimit },
    ...(provider ? [{ scope: `provider:${provider}`, limit: providerLimit }] : []),
  ];
  const acquired = [];

  for (const entry of scopes) {
    const lease = acquireScopeLease(entry.scope, entry.limit);
    if (!lease.ok) {
      for (const held of acquired.reverse()) held.release();
      return {
        ok: false,
        reason: lease.reason,
        scope: lease.scope,
        retryAfterMs: lease.retryAfterMs || DEFAULT_RETRY_AFTER_MS,
        state: getSharedLimiterState(),
      };
    }
    acquired.push(lease);
  }

  return {
    ok: true,
    skipped: false,
    scopes: acquired.map((lease) => lease.scope),
    release() {
      for (const lease of acquired.reverse()) lease.release();
    },
  };
}

function getSharedLimiterState() {
  const state = {
    enabled: enabledFlag('HUB_LLM_SHARED_LIMITER_ENABLED', true),
    dir: LIMITER_DIR,
    lease_ttl_ms: DEFAULT_LEASE_TTL_MS,
    scopes: {},
  };
  try {
    fs.mkdirSync(LIMITER_DIR, { recursive: true });
    for (const entry of fs.readdirSync(LIMITER_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(LIMITER_DIR, entry.name);
      pruneStaleLeases(dir);
      state.scopes[entry.name] = { in_flight: countLeases(dir) };
    }
  } catch (error) {
    state.error = error.message;
  }
  return state;
}

function resetSharedLimiterForTests() {
  try {
    fs.rmSync(LIMITER_DIR, { recursive: true, force: true });
  } catch {
    // Test cleanup only.
  }
}

module.exports = {
  acquireSharedLimiterLease,
  getSharedLimiterState,
  resetSharedLimiterForTests,
};
