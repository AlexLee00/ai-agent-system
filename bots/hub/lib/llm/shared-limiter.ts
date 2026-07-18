const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalHubTeam } = require('../team-identity');

type SharedLimiterIdentity = {
  team?: string;
  provider?: string;
};

type SharedLimiterLease = {
  ok: true;
  skipped?: boolean;
  backend?: string;
  scopes: string[];
  signal: AbortSignal;
  isValid: () => boolean;
  release: () => void | Promise<void>;
};

type SharedLimiterRejection = {
  ok: false;
  backend?: string;
  scope?: string;
  reason: string;
  retryAfterMs: number;
  state?: unknown;
  error?: string;
  cleanupUncertain?: boolean;
};

type SharedLimiterDeps = {
  acquireScopeLease?: (scope: string, limit: number) => Promise<ScopeLease>;
  releaseAttempts?: number;
};

type ScopeLease = {
  ok: true;
  scope: string;
  limit: number;
  file?: string;
  slot?: number;
  leaseId?: string;
  renew: () => Promise<boolean>;
  release: () => void | Promise<void>;
} | {
  ok: false;
  scope: string;
  limit: number;
  reason: string;
  retryAfterMs: number;
  error?: string;
  inFlight?: number;
};

function parseEnvNumber(name: string, fallback: number, minValue: number): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minValue, Math.floor(parsed));
}

function enabledFlag(name: string, fallback = true): boolean {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

const DEFAULT_LOCAL_LIMIT = parseEnvNumber('HUB_LLM_MAX_IN_FLIGHT', 16, 1);
const DEFAULT_LEASE_TTL_MS = parseEnvNumber('HUB_LLM_SHARED_LEASE_TTL_MS', 60_000, 1_000);
const DEFAULT_RETRY_AFTER_MS = parseEnvNumber('HUB_LLM_RETRY_AFTER_MS', 1_000, 200);
const FILE_SLOT_LOCK_TTL_MS = 30_000;
const LIMITER_DIR = process.env.HUB_LLM_SHARED_LIMITER_DIR
  || path.join(os.tmpdir(), 'ai-agent-system-hub-llm-limiter');
const FILE_OWNER_DIR_NAME = '.process-owners';

let pgEnsurePromise: Promise<void> | null = null;
let fileOwnerPath: string | null = null;
const fileOwnerGlobal = globalThis as typeof globalThis & {
  __hubSharedLimiterFileOwner?: { ownerId: string; startedAtNs: string };
};
fileOwnerGlobal.__hubSharedLimiterFileOwner ||= {
  ownerId: createLeaseId(),
  startedAtNs: process.hrtime.bigint().toString(),
};
const fileOwnerId = fileOwnerGlobal.__hubSharedLimiterFileOwner.ownerId;
const fileOwnerStartedAtNs = fileOwnerGlobal.__hubSharedLimiterFileOwner.startedAtNs;

function limiterBackend(): 'file' | 'pg' {
  const raw = String(process.env.HUB_LLM_SHARED_LIMITER_BACKEND || 'file').trim().toLowerCase();
  return raw === 'pg' || raw === 'postgres' || raw === 'postgresql' ? 'pg' : 'file';
}

function createLeaseId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `lease_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

function sanitizeScope(raw: unknown): string {
  const value = String(raw || 'unknown').trim().toLowerCase().replace(/[^a-z0-9_.:-]+/g, '_');
  return value || 'unknown';
}

function scopeDir(scope: string): string {
  return path.join(LIMITER_DIR, sanitizeScope(scope));
}

function ensureScopeDir(scope: string): string {
  const dir = scopeDir(scope);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

function ownerSortKey(owner: Record<string, unknown>): [bigint, string] {
  try {
    return [BigInt(String(owner.startedAtNs || '0')), String(owner.ownerId || '')];
  } catch {
    return [0n, String(owner.ownerId || '')];
  }
}

function compareFileOwners(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const [leftStarted, leftId] = ownerSortKey(left);
  const [rightStarted, rightId] = ownerSortKey(right);
  if (leftStarted < rightStarted) return -1;
  if (leftStarted > rightStarted) return 1;
  return leftId.localeCompare(rightId);
}

function ensureFileBackendSingleProcessOwner(): { ok: true } | { ok: false; ownerPid: number | null } {
  const ownerDir = path.join(LIMITER_DIR, FILE_OWNER_DIR_NAME);
  fs.mkdirSync(ownerDir, { recursive: true });
  if (!fileOwnerPath || !fs.existsSync(fileOwnerPath)) {
    const ownerPath = path.join(ownerDir, `${process.pid}-${fileOwnerId}.owner`);
    fileOwnerPath = ownerPath;
    try {
      fs.writeFileSync(ownerPath, JSON.stringify({
        ownerId: fileOwnerId,
        pid: process.pid,
        startedAtNs: fileOwnerStartedAtNs,
        createdAt: new Date().toISOString(),
      }), { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'EEXIST'
        || String(safeReadJson(ownerPath)?.ownerId || '') !== fileOwnerId) throw error;
    }
  }

  const liveOwners: Record<string, unknown>[] = [];
  for (const name of fs.readdirSync(ownerDir)) {
    if (!name.endsWith('.owner')) continue;
    const ownerFile = path.join(ownerDir, name);
    const owner = safeReadJson(ownerFile) || {};
    const pid = Number(owner.pid || name.match(/^(\d+)-/)?.[1] || 0);
    if (!isProcessAlive(pid)) {
      try {
        fs.unlinkSync(ownerFile);
      } catch {}
      continue;
    }
    liveOwners.push({ ...owner, pid, ownerFile });
  }

  const winner = [...liveOwners].sort(compareFileOwners)[0];
  if (!winner || String(winner.ownerId || '') === fileOwnerId) return { ok: true };
  try {
    if (fileOwnerPath) fs.unlinkSync(fileOwnerPath);
  } catch {}
  fileOwnerPath = null;
  return { ok: false, ownerPid: Number(winner.pid) || null };
}

function safeReadJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function withFileSlotLock<T>(file: string, action: () => T): { ok: true; value: T } | { ok: false } {
  const lockFile = `${file}.lock`;
  const lockId = createLeaseId();
  let fd: number | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fd = fs.openSync(lockFile, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify({ lockId, expiresAt: Date.now() + FILE_SLOT_LOCK_TTL_MS }));
      } catch {
        fs.closeSync(fd);
        fd = null;
        try {
          fs.unlinkSync(lockFile);
        } catch {}
        return { ok: false };
      }
      break;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err?.code !== 'EEXIST') return { ok: false };
      const current = safeReadJson(lockFile);
      const expiresAt = Number(current?.expiresAt || 0);
      if (expiresAt > Date.now()) return { ok: false };
      if (!expiresAt) {
        try {
          if (Date.now() - fs.statSync(lockFile).mtimeMs < FILE_SLOT_LOCK_TTL_MS) return { ok: false };
        } catch {
          return { ok: false };
        }
      }
      try {
        fs.unlinkSync(lockFile);
      } catch {
        return { ok: false };
      }
    }
  }
  if (fd === null) return { ok: false };

  try {
    return { ok: true, value: action() };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
    if (String(safeReadJson(lockFile)?.lockId || '') === lockId) {
      try {
        fs.unlinkSync(lockFile);
      } catch {}
    }
  }
}

function pruneStaleLeases(dir: string, now = Date.now()): number {
  let pruned = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.lease')) continue;
    const file = path.join(dir, entry.name);
    const observed = safeReadJson(file);
    if (Number(observed?.expiresAt || 0) > now) continue;
    const result = withFileSlotLock(file, () => {
      const payload = safeReadJson(file);
      const expiresAt = Number(payload?.expiresAt || 0);
      if (expiresAt > now) return false;
      try {
        fs.unlinkSync(file);
        return true;
      } catch {
        return false;
      }
    });
    if (result.ok && result.value) pruned += 1;
  }
  return pruned;
}

function countLeases(dir: string): number {
  try {
    return fs.readdirSync(dir).filter((name: string) => name.endsWith('.lease')).length;
  } catch {
    return 0;
  }
}

function acquireFileScopeLease(scope: string, limit: number, now = Date.now()): ScopeLease {
  const dir = ensureScopeDir(scope);
  pruneStaleLeases(dir, now);
  for (let index = 0; index < limit; index += 1) {
    const file = path.join(dir, `${index}.lease`);
    if (fs.existsSync(file)) continue;
    const locked = withFileSlotLock(file, (): ScopeLease | null => {
      try {
        const fd = fs.openSync(file, 'wx');
        const leaseId = createLeaseId();
        try {
          fs.writeFileSync(fd, JSON.stringify({
            scope,
            leaseId,
            pid: process.pid,
            createdAt: now,
            expiresAt: now + DEFAULT_LEASE_TTL_MS,
          }));
        } finally {
          fs.closeSync(fd);
        }
        return {
          ok: true,
          scope,
          limit,
          file,
          slot: index,
          leaseId,
          renew: async () => renewFileScopeLease(file, leaseId),
          release() {
            if (releaseFileScopeLease(file, leaseId)) return;
            return retryFileScopeLeaseRelease(file, leaseId);
          },
        };
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err?.code === 'EEXIST') return null;
        return {
          ok: false,
          scope,
          limit,
          reason: 'shared_limiter_io_error',
          error: err.message,
          retryAfterMs: DEFAULT_RETRY_AFTER_MS,
        };
      }
    });
    if (!locked.ok || !locked.value) continue;
    if (!locked.value.ok) return locked.value;
    return locked.value;
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

function isOwnedLiveFileLease(file: string, leaseId: string, now = Date.now()): boolean {
  const payload = safeReadJson(file);
  return String(payload?.leaseId || '') === leaseId
    && Number(payload?.expiresAt || 0) > now;
}

function renewFileScopeLease(file: string, leaseId: string, now = Date.now()): boolean {
  const result = withFileSlotLock(file, () => {
    const payload = safeReadJson(file);
    if (String(payload?.leaseId || '') !== leaseId) return false;
    const expiresAt = Number(payload?.expiresAt || 0);
    if (!expiresAt || expiresAt <= now) return false;
    try {
      fs.writeFileSync(file, JSON.stringify({
        ...payload,
        renewedAt: now,
        expiresAt: now + DEFAULT_LEASE_TTL_MS,
      }));
      return String(safeReadJson(file)?.leaseId || '') === leaseId;
    } catch {
      return false;
    }
  });
  if (result.ok) return result.value;
  return isOwnedLiveFileLease(file, leaseId, now);
}

function releaseFileScopeLease(file: string, leaseId: string): boolean {
  const result = withFileSlotLock(file, () => {
    const payload = safeReadJson(file);
    if (String(payload?.leaseId || '') !== leaseId) return false;
    try {
      fs.unlinkSync(file);
      return true;
    } catch {
      return false;
    }
  });
  return result.ok && result.value;
}

async function retryFileScopeLeaseRelease(file: string, leaseId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const payload = safeReadJson(file);
    if (!payload || String(payload.leaseId || '') !== leaseId) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (releaseFileScopeLease(file, leaseId)) return;
  }
  throw new Error('shared_limiter_file_release_failed');
}

type PgPoolModule = {
  run: (schema: string, sql: string, params?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>;
  get: <T = any>(schema: string, sql: string, params?: unknown[]) => Promise<T | null>;
};

function getPgPool(): PgPoolModule {
  return require('../../../../packages/core/lib/pg-pool') as PgPoolModule;
}

async function ensurePgLimiterTable(): Promise<void> {
  if (pgEnsurePromise) return pgEnsurePromise;
  pgEnsurePromise = (async () => {
    const pgPool = getPgPool();
    await pgPool.run('agent', `
      CREATE TABLE IF NOT EXISTS hub_llm_limiter_leases (
        scope TEXT NOT NULL,
        slot INTEGER NOT NULL,
        lease_id TEXT NOT NULL,
        pid INTEGER,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (scope, slot)
      )
    `);
    await pgPool.run('agent', `
      CREATE INDEX IF NOT EXISTS hub_llm_limiter_leases_expires_idx
      ON hub_llm_limiter_leases (expires_at)
    `);
  })().catch((error: unknown) => {
    pgEnsurePromise = null;
    throw error;
  });
  return pgEnsurePromise;
}

async function acquirePgScopeLease(scope: string, limit: number): Promise<ScopeLease> {
  await ensurePgLimiterTable();
  const pgPool = getPgPool();
  const leaseId = createLeaseId();
  await pgPool.run('agent', 'DELETE FROM hub_llm_limiter_leases WHERE expires_at <= NOW()');
  for (let slot = 0; slot < limit; slot += 1) {
    const result = await pgPool.run('agent', `
      INSERT INTO hub_llm_limiter_leases (scope, slot, lease_id, pid, expires_at)
      VALUES ($1, $2, $3, $4, NOW() + ($5 || ' milliseconds')::interval)
      ON CONFLICT (scope, slot) DO NOTHING
      RETURNING scope, slot
    `, [scope, slot, leaseId, process.pid, DEFAULT_LEASE_TTL_MS]);
    if (result.rowCount > 0) {
      return {
        ok: true,
        scope,
        limit,
        slot,
        leaseId,
        async renew() {
          const result = await pgPool.run('agent', `
            UPDATE hub_llm_limiter_leases
            SET expires_at = NOW() + ($4 || ' milliseconds')::interval
            WHERE scope = $1 AND slot = $2 AND lease_id = $3 AND expires_at > NOW()
          `, [scope, slot, leaseId, DEFAULT_LEASE_TTL_MS]);
          return result.rowCount > 0;
        },
        async release() {
          await pgPool.run('agent', `
            DELETE FROM hub_llm_limiter_leases
            WHERE scope = $1 AND slot = $2 AND lease_id = $3
          `, [scope, slot, leaseId]);
        },
      };
    }
  }
  const row = await pgPool.get<{ count: string }>('agent', `
    SELECT COUNT(*)::text AS count
    FROM hub_llm_limiter_leases
    WHERE scope = $1 AND expires_at > NOW()
  `, [scope]);
  return {
    ok: false,
    scope,
    limit,
    reason: 'shared_limiter_full',
    inFlight: Number(row?.count || 0),
    retryAfterMs: DEFAULT_RETRY_AFTER_MS,
  };
}

async function acquireScopeLease(scope: string, limit: number): Promise<ScopeLease> {
  if (limiterBackend() === 'pg') {
    try {
      return await acquirePgScopeLease(scope, limit);
    } catch (error) {
      const err = error as Error;
      return {
        ok: false,
        scope,
        limit,
        reason: 'shared_limiter_pg_error',
        retryAfterMs: DEFAULT_RETRY_AFTER_MS,
        error: err.message,
      };
    }
  }
  return acquireFileScopeLease(scope, limit);
}

async function releaseScopeLeaseWithRetry(lease: Extract<ScopeLease, { ok: true }>, attempts: number): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await lease.release();
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError || new Error('shared_limiter_release_failed');
}

async function releaseScopeLeases(
  leases: Extract<ScopeLease, { ok: true }>[],
  attempts: number,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const results = await Promise.allSettled(
    [...leases].reverse().map((lease) => releaseScopeLeaseWithRetry(lease, attempts)),
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (!failure || failure.status !== 'rejected') return { ok: true };
  return { ok: false, error: String((failure.reason as Error)?.message || failure.reason || 'shared_limiter_release_failed') };
}

function buildScopes(identity: SharedLimiterIdentity = {}): Array<{ scope: string; limit: number }> {
  const team = sanitizeScope(canonicalHubTeam(identity.team || 'unknown'));
  const provider = sanitizeScope(identity.provider || '');
  const globalLimit = parseEnvNumber('HUB_LLM_SHARED_MAX_IN_FLIGHT', DEFAULT_LOCAL_LIMIT, 1);
  const teamLimit = parseEnvNumber('HUB_LLM_SHARED_TEAM_MAX_IN_FLIGHT', DEFAULT_LOCAL_LIMIT, 1);
  const providerLimit = parseEnvNumber('HUB_LLM_SHARED_PROVIDER_MAX_IN_FLIGHT', DEFAULT_LOCAL_LIMIT, 1);
  return [
    { scope: 'global', limit: globalLimit },
    { scope: `team:${team}`, limit: teamLimit },
    ...(provider ? [{ scope: `provider:${provider}`, limit: providerLimit }] : []),
  ];
}

async function acquireSharedLimiterLease(
  identity: SharedLimiterIdentity = {},
  deps: SharedLimiterDeps = {},
): Promise<SharedLimiterLease | SharedLimiterRejection> {
  if (!enabledFlag('HUB_LLM_SHARED_LIMITER_ENABLED', true)) {
    const controller = new AbortController();
    return {
      ok: true,
      skipped: true,
      backend: limiterBackend(),
      scopes: [],
      signal: controller.signal,
      isValid: () => true,
      release() {},
    };
  }

  const backend = limiterBackend();
  if (backend === 'file') {
    try {
      const owner = ensureFileBackendSingleProcessOwner();
      if (!owner.ok) {
        return {
          ok: false,
          backend,
          scope: 'backend:file',
          reason: 'shared_limiter_file_backend_single_process',
          retryAfterMs: DEFAULT_RETRY_AFTER_MS,
          error: owner.ownerPid ? `active_owner_pid:${owner.ownerPid}` : 'active_owner_unknown',
        };
      }
    } catch (error) {
      return {
        ok: false,
        backend,
        scope: 'backend:file',
        reason: 'shared_limiter_file_owner_check_failed',
        retryAfterMs: DEFAULT_RETRY_AFTER_MS,
        error: (error as Error).message,
      };
    }
  }
  const acquired: Extract<ScopeLease, { ok: true }>[] = [];
  const acquire = deps.acquireScopeLease || acquireScopeLease;
  const releaseAttempts = Math.max(1, Math.floor(Number(deps.releaseAttempts || 3)));

  for (const entry of buildScopes(identity)) {
    const lease = await acquire(entry.scope, entry.limit);
    if (!lease.ok) {
      const cleanup = await releaseScopeLeases(acquired, releaseAttempts);
      if (!cleanup.ok) {
        console.error(`[llm/shared-limiter] partial acquisition rollback failed: ${cleanup.error}`);
        return {
          ok: false,
          backend,
          reason: 'shared_limiter_release_failed',
          scope: lease.scope,
          retryAfterMs: lease.retryAfterMs || DEFAULT_RETRY_AFTER_MS,
          error: cleanup.error,
          cleanupUncertain: true,
          state: getSharedLimiterState(),
        };
      }
      return {
        ok: false,
        backend,
        reason: lease.reason,
        scope: lease.scope,
        retryAfterMs: lease.retryAfterMs || DEFAULT_RETRY_AFTER_MS,
        error: lease.error,
        state: getSharedLimiterState(),
      };
    }
    acquired.push(lease);
  }

  const validations = await Promise.allSettled(acquired.map((lease) => lease.renew()));
  const lostIndex = validations.findIndex((result) => result.status === 'rejected' || result.value !== true);
  if (lostIndex >= 0) {
    const lostScope = acquired[lostIndex]?.scope || 'unknown';
    const cleanup = await releaseScopeLeases(acquired, releaseAttempts);
    if (!cleanup.ok) {
      console.error(`[llm/shared-limiter] invalid composite rollback failed: ${cleanup.error}`);
      return {
        ok: false,
        backend,
        reason: 'shared_limiter_release_failed',
        scope: lostScope,
        retryAfterMs: DEFAULT_RETRY_AFTER_MS,
        error: cleanup.error,
        cleanupUncertain: true,
        state: getSharedLimiterState(),
      };
    }
    return {
      ok: false,
      backend,
      reason: 'shared_limiter_lease_lost',
      scope: lostScope,
      retryAfterMs: DEFAULT_RETRY_AFTER_MS,
      state: getSharedLimiterState(),
    };
  }

  const controller = new AbortController();
  let valid = true;
  let released = false;
  let renewalInProgress = false;
  const configuredRenewMs = Math.min(
    parseEnvNumber(
      'HUB_LLM_SHARED_LEASE_RENEW_MS',
      Math.min(20_000, Math.max(250, Math.floor(DEFAULT_LEASE_TTL_MS / 3))),
      250,
    ),
    Math.max(250, Math.floor(DEFAULT_LEASE_TTL_MS / 2)),
  );
  const renewAll = async () => {
    if (released || renewalInProgress || !valid) return;
    renewalInProgress = true;
    try {
      for (const lease of acquired) {
        if (!await lease.renew()) {
          valid = false;
          controller.abort(new Error(`shared_limiter_lease_lost:${lease.scope}`));
          break;
        }
      }
    } catch {
      valid = false;
      controller.abort(new Error('shared_limiter_lease_renew_failed'));
    } finally {
      renewalInProgress = false;
    }
  };
  const renewTimer = setInterval(() => { void renewAll(); }, configuredRenewMs);
  renewTimer.unref?.();

  return {
    ok: true,
    backend,
    skipped: false,
    scopes: acquired.map((lease) => lease.scope),
    signal: controller.signal,
    isValid: () => valid && !released,
    async release() {
      if (released) return;
      released = true;
      clearInterval(renewTimer);
      const cleanup = await releaseScopeLeases(acquired, releaseAttempts);
      if (!cleanup.ok) throw new Error(cleanup.error || 'shared_limiter_release_failed');
    },
  };
}

function getSharedLimiterState(): Record<string, unknown> {
  const backend = limiterBackend();
  const state: Record<string, unknown> = {
    enabled: enabledFlag('HUB_LLM_SHARED_LIMITER_ENABLED', true),
    backend,
    lease_ttl_ms: DEFAULT_LEASE_TTL_MS,
    limits: {
      global: parseEnvNumber('HUB_LLM_SHARED_MAX_IN_FLIGHT', DEFAULT_LOCAL_LIMIT, 1),
      team: parseEnvNumber('HUB_LLM_SHARED_TEAM_MAX_IN_FLIGHT', DEFAULT_LOCAL_LIMIT, 1),
      provider: parseEnvNumber('HUB_LLM_SHARED_PROVIDER_MAX_IN_FLIGHT', DEFAULT_LOCAL_LIMIT, 1),
    },
    capabilities: {
      multi_process: backend === 'pg',
      multi_node: backend === 'pg',
      fairness_scope: ['global', 'team', 'provider'],
    },
  };
  if (backend === 'pg') {
    state.store = 'postgres';
    state.table = 'agent.hub_llm_limiter_leases';
    return state;
  }

  state.dir = LIMITER_DIR;
  state.scopes = {};
  try {
    fs.mkdirSync(LIMITER_DIR, { recursive: true });
    for (const entry of fs.readdirSync(LIMITER_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === FILE_OWNER_DIR_NAME) continue;
      const dir = path.join(LIMITER_DIR, entry.name);
      pruneStaleLeases(dir);
      (state.scopes as Record<string, unknown>)[entry.name] = { in_flight: countLeases(dir) };
    }
  } catch (error) {
    state.error = (error as Error).message;
  }
  return state;
}

function resetSharedLimiterForTests(): void {
  try {
    fs.rmSync(LIMITER_DIR, { recursive: true, force: true });
  } catch {
    // Test cleanup only.
  }
  fileOwnerPath = null;
}

module.exports = {
  acquireSharedLimiterLease,
  getSharedLimiterState,
  resetSharedLimiterForTests,
  _testOnly: {
    acquireFileScopeLease,
    renewFileScopeLease,
    releaseFileScopeLease,
    ensureFileBackendSingleProcessOwner,
  },
};
