const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

type SharedLimiterIdentity = {
  team?: string;
  provider?: string;
};

type SharedLimiterLease = {
  ok: true;
  skipped?: boolean;
  backend?: string;
  scopes: string[];
  release: () => void;
};

type SharedLimiterRejection = {
  ok: false;
  backend?: string;
  scope?: string;
  reason: string;
  retryAfterMs: number;
  state?: unknown;
  error?: string;
};

type ScopeLease = {
  ok: true;
  scope: string;
  limit: number;
  file?: string;
  slot?: number;
  leaseId?: string;
  release: () => void;
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
const LIMITER_DIR = process.env.HUB_LLM_SHARED_LIMITER_DIR
  || path.join(os.tmpdir(), 'ai-agent-system-hub-llm-limiter');

let pgEnsurePromise: Promise<void> | null = null;

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

function safeReadJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function pruneStaleLeases(dir: string, now = Date.now()): number {
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
      const err = error as NodeJS.ErrnoException;
      if (err?.code !== 'EEXIST') {
        return {
          ok: false,
          scope,
          limit,
          reason: 'shared_limiter_io_error',
          error: err.message,
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
        release() {
          pgPool.run('agent', `
            DELETE FROM hub_llm_limiter_leases
            WHERE scope = $1 AND slot = $2 AND lease_id = $3
          `, [scope, slot, leaseId]).catch(() => {
            // Release is best-effort; TTL pruning handles abandoned leases.
          });
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

function buildScopes(identity: SharedLimiterIdentity = {}): Array<{ scope: string; limit: number }> {
  const team = sanitizeScope(identity.team || 'unknown');
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

async function acquireSharedLimiterLease(identity: SharedLimiterIdentity = {}): Promise<SharedLimiterLease | SharedLimiterRejection> {
  if (!enabledFlag('HUB_LLM_SHARED_LIMITER_ENABLED', true)) {
    return {
      ok: true,
      skipped: true,
      backend: limiterBackend(),
      scopes: [],
      release() {},
    };
  }

  const backend = limiterBackend();
  const acquired: Extract<ScopeLease, { ok: true }>[] = [];

  for (const entry of buildScopes(identity)) {
    const lease = await acquireScopeLease(entry.scope, entry.limit);
    if (!lease.ok) {
      for (const held of acquired.reverse()) held.release();
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

  return {
    ok: true,
    backend,
    skipped: false,
    scopes: acquired.map((lease) => lease.scope),
    release() {
      for (const lease of acquired.reverse()) lease.release();
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
      multi_process: true,
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
}

module.exports = {
  acquireSharedLimiterLease,
  getSharedLimiterState,
  resetSharedLimiterForTests,
};
