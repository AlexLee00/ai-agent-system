const fs = require('node:fs');
const path = require('node:path');
const { callWithFallback } = require('./unified-caller');
const { acquireSharedLimiterLease } = require('./shared-limiter');

type LlmJobStatus = 'queued' | 'running' | 'completed' | 'failed';

type LlmJobPayload = {
  prompt?: string;
  callerTeam?: string;
  agent?: string;
  selectorKey?: string;
  abstractModel?: string;
  traceId?: string;
  provider?: string;
  [key: string]: unknown;
};

type LlmJob = {
  id: string;
  status: LlmJobStatus;
  createdAt: string;
  updatedAt: string;
  traceId: string | null;
  callerTeam: string | null;
  agent: string | null;
  payload: LlmJobPayload;
  payloadSummary: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  attempts: number;
  source: string;
  retryAfterMs?: number;
  limiter?: unknown;
  providerBackpressure?: unknown;
  startedAt?: string;
  finishedAt?: string;
};

type CreateJobOptions = {
  source?: string;
  start?: boolean;
};

type JobContext = {
  traceId?: string;
  callerTeam?: string;
  agent?: string;
};

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const JOB_DIR = process.env.HUB_LLM_JOB_DIR || path.join(repoRoot, 'bots/hub/output/llm-jobs');
const JOB_RETRY_AFTER_MS = Number(process.env.HUB_LLM_JOB_RETRY_AFTER_MS || 1_000);
const activeJobs = new Set<string>();
let pgEnsurePromise: Promise<void> | null = null;

function jobStoreBackend(): 'file' | 'pg' {
  const raw = String(process.env.HUB_LLM_JOB_STORE_BACKEND || 'file').trim().toLowerCase();
  return raw === 'pg' || raw === 'postgres' || raw === 'postgresql' ? 'pg' : 'file';
}

function ensureJobDir(): void {
  fs.mkdirSync(JOB_DIR, { recursive: true });
}

function jobPath(jobId: string): string {
  return path.join(JOB_DIR, `${String(jobId || '').replace(/[^a-zA-Z0-9_.:-]+/g, '_')}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

function createJobId(): string {
  return `llm_job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

type PgPoolModule = {
  run: (schema: string, sql: string, params?: unknown[]) => Promise<{ rowCount: number; rows: unknown[] }>;
  get: <T = any>(schema: string, sql: string, params?: unknown[]) => Promise<T | null>;
  query: <T = any>(schema: string, sql: string, params?: unknown[]) => Promise<T[]>;
};

function getPgPool(): PgPoolModule {
  return require('../../../../packages/core/lib/pg-pool') as PgPoolModule;
}

async function ensurePgJobTable(): Promise<void> {
  if (pgEnsurePromise) return pgEnsurePromise;
  pgEnsurePromise = (async () => {
    const pgPool = getPgPool();
    await pgPool.run('agent', `
      CREATE TABLE IF NOT EXISTS hub_llm_jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        job JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pgPool.run('agent', `
      CREATE INDEX IF NOT EXISTS hub_llm_jobs_status_updated_idx
      ON hub_llm_jobs (status, updated_at DESC)
    `);
  })().catch((error: unknown) => {
    pgEnsurePromise = null;
    throw error;
  });
  return pgEnsurePromise;
}

async function writeJob(job: LlmJob): Promise<LlmJob> {
  if (jobStoreBackend() === 'pg') {
    await ensurePgJobTable();
    const pgPool = getPgPool();
    await pgPool.run('agent', `
      INSERT INTO hub_llm_jobs (id, status, job, created_at, updated_at)
      VALUES ($1, $2, $3::jsonb, $4::timestamptz, $5::timestamptz)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        job = EXCLUDED.job,
        updated_at = EXCLUDED.updated_at
    `, [job.id, job.status, JSON.stringify(job), job.createdAt, job.updatedAt]);
    return job;
  }

  ensureJobDir();
  fs.writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2));
  return job;
}

async function readJob(jobId: string): Promise<LlmJob | null> {
  if (jobStoreBackend() === 'pg') {
    await ensurePgJobTable();
    const pgPool = getPgPool();
    const row = await pgPool.get<{ job: LlmJob }>('agent', 'SELECT job FROM hub_llm_jobs WHERE id = $1', [jobId]);
    return row?.job?.id ? row.job : null;
  }

  try {
    const job = JSON.parse(fs.readFileSync(jobPath(jobId), 'utf8')) as LlmJob;
    return job && job.id ? job : null;
  } catch {
    return null;
  }
}

async function updateJob(jobId: string, patch: Partial<LlmJob>): Promise<LlmJob | null> {
  const current = await readJob(jobId);
  if (!current) return null;
  return writeJob({
    ...current,
    ...patch,
    updatedAt: nowIso(),
  });
}

function summarizePayload(payload: LlmJobPayload = {}): Record<string, unknown> {
  return {
    callerTeam: payload.callerTeam || null,
    agent: payload.agent || null,
    selectorKey: payload.selectorKey || null,
    abstractModel: payload.abstractModel || null,
    promptBytes: Buffer.byteLength(String(payload.prompt || ''), 'utf8'),
  };
}

async function createLlmJob(payload: LlmJobPayload, context: JobContext = {}, options: CreateJobOptions = {}): Promise<LlmJob> {
  const job: LlmJob = {
    id: createJobId(),
    status: 'queued',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    traceId: context.traceId || payload.traceId || null,
    callerTeam: payload.callerTeam || context.callerTeam || null,
    agent: payload.agent || context.agent || null,
    payload,
    payloadSummary: summarizePayload(payload),
    result: null,
    error: null,
    attempts: 0,
    source: options.source || 'api',
  };
  await writeJob(job);
  if (options.start !== false) scheduleJob(job.id);
  return job;
}

function scheduleJob(jobId: string): void {
  if (activeJobs.has(jobId)) return;
  setImmediate(() => {
    processJob(jobId).catch((error: unknown) => {
      updateJob(jobId, {
        status: 'failed',
        error: (error as Error)?.message || String(error),
        finishedAt: nowIso(),
      }).catch(() => {});
    });
  });
}

async function processJob(jobId: string): Promise<LlmJob | null> {
  if (activeJobs.has(jobId)) return readJob(jobId);
  const job = await readJob(jobId);
  if (!job || job.status === 'completed' || job.status === 'failed') return job;
  activeJobs.add(jobId);

  let lease: { ok: boolean; scopes?: string[]; skipped?: boolean; release?: () => void; retryAfterMs?: number } | null = null;
  try {
    lease = await acquireSharedLimiterLease({
      team: job.callerTeam || job.payload?.callerTeam || 'unknown',
      provider: job.payload?.provider || '',
    });
    if (!lease || !lease.ok) {
      await updateJob(jobId, {
        status: 'queued',
        retryAfterMs: lease?.retryAfterMs || JOB_RETRY_AFTER_MS,
        limiter: lease,
      });
      setTimeout(() => scheduleJob(jobId), lease?.retryAfterMs || JOB_RETRY_AFTER_MS).unref?.();
      return readJob(jobId);
    }
    const acquiredLease = lease;

    await updateJob(jobId, {
      status: 'running',
      startedAt: nowIso(),
      attempts: Number(job.attempts || 0) + 1,
      limiter: { scopes: acquiredLease.scopes || [], skipped: Boolean(acquiredLease.skipped) },
    });

    const result = shouldMockJobs()
      ? {
          ok: true,
          provider: 'mock',
          result: 'hub llm job smoke result',
          durationMs: 0,
          totalCostUsd: 0,
        }
      : await callWithFallback({
          ...job.payload,
          traceId: job.traceId || undefined,
          callerTeam: job.payload?.callerTeam || job.callerTeam || undefined,
          agent: job.payload?.agent || job.agent || undefined,
        });

    await updateJob(jobId, {
      status: result?.ok ? 'completed' : 'failed',
      result: result?.ok ? result : null,
      error: result?.ok ? null : (result?.error || 'llm_job_failed'),
      providerBackpressure: buildJobBackpressure(result),
      finishedAt: nowIso(),
    });
    return readJob(jobId);
  } finally {
    try {
      lease?.release?.();
    } finally {
      activeJobs.delete(jobId);
    }
  }
}

function buildJobBackpressure(result: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const error = String(result?.error || '').toLowerCase();
  if (!error) return null;
  if (error.includes('429') || error.includes('rate limit') || error.includes('quota')) {
    return { kind: 'provider_rate_limit', retryAfterMs: 60_000 };
  }
  if (error.includes('provider_cooldown')) return { kind: 'provider_cooldown', retryAfterMs: 60_000 };
  if (error.includes('provider_circuit_open')) return { kind: 'provider_circuit_open', retryAfterMs: 15_000 };
  return null;
}

function shouldMockJobs(): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env.HUB_LLM_JOB_SMOKE_MOCK || '').trim().toLowerCase());
}

function summarizeJob(job: LlmJob): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    traceId: job.traceId || null,
    payloadSummary: job.payloadSummary || summarizePayload(job.payload),
  };
}

async function listLlmJobs(limit = 20): Promise<Array<Record<string, unknown>>> {
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  if (jobStoreBackend() === 'pg') {
    await ensurePgJobTable();
    const pgPool = getPgPool();
    const rows = await pgPool.query<{ job: LlmJob }>('agent', `
      SELECT job
      FROM hub_llm_jobs
      ORDER BY updated_at DESC
      LIMIT $1
    `, [normalizedLimit]);
    return rows.map((row) => summarizeJob(row.job)).filter(Boolean);
  }

  ensureJobDir();
  const files = fs.readdirSync(JOB_DIR)
    .filter((name: string) => name.endsWith('.json'))
    .map((name: string) => path.join(JOB_DIR, name))
    .sort((a: string, b: string) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, normalizedLimit);
  return files.map((file: string) => {
    try {
      const job = JSON.parse(fs.readFileSync(file, 'utf8')) as LlmJob;
      return summarizeJob(job);
    } catch {
      return null;
    }
  }).filter(Boolean) as Array<Record<string, unknown>>;
}

async function getJobStoreState(): Promise<Record<string, unknown>> {
  const backend = jobStoreBackend();
  const state: Record<string, unknown> = {
    backend,
    active: activeJobs.size,
    capabilities: {
      multi_process: true,
      multi_node: backend === 'pg',
      async_workers: true,
    },
  };
  if (backend === 'pg') {
    state.store = 'postgres';
    state.table = 'agent.hub_llm_jobs';
    return state;
  }
  state.dir = JOB_DIR;
  return state;
}

async function resetJobStoreForTests(): Promise<void> {
  activeJobs.clear();
  if (jobStoreBackend() === 'pg') {
    await ensurePgJobTable();
    await getPgPool().run('agent', 'DELETE FROM hub_llm_jobs');
    return;
  }
  try {
    fs.rmSync(JOB_DIR, { recursive: true, force: true });
  } catch {
    // Test cleanup only.
  }
}

module.exports = {
  createLlmJob,
  readJob,
  listLlmJobs,
  processJob,
  getJobStoreState,
  resetJobStoreForTests,
};
