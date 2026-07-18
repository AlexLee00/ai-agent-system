const fs = require('node:fs');
const path = require('node:path');
const { callWithFallback } = require('./unified-caller');
const { isLlmRouteTargetAllowed } = require('../../../../packages/core/lib/llm-model-selector');
const { canonicalHubTeam } = require('../team-identity');

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
  ownerTeam?: string | null;
  ownerPrincipalId?: string | null;
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
  authPrincipalId?: string | null;
};

type ProcessJobDeps = {
  callWithFallback?: (payload: LlmJobPayload) => Promise<Record<string, unknown>>;
  scheduleJob?: (jobId: string, retryAfterMs: number) => void;
};

type LlmJobOwner = {
  callerTeam: string;
  authPrincipalId?: string | null;
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
    return row?.job?.id === jobId ? row.job : null;
  }

  try {
    const job = JSON.parse(fs.readFileSync(jobPath(jobId), 'utf8')) as LlmJob;
    return job?.id === jobId ? job : null;
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
  const targetPolicy = isLlmRouteTargetAllowed({
    callerTeam: payload.callerTeam || context.callerTeam || null,
    agent: payload.agent || context.agent || null,
    selectorKey: payload.selectorKey || null,
  });
  if (!targetPolicy.ok) {
    const error = new Error(targetPolicy.error || 'llm_route_target_blocked') as Error & {
      code?: string;
      target?: unknown;
    };
    error.code = targetPolicy.error || 'llm_route_target_blocked';
    error.target = targetPolicy.target;
    throw error;
  }
  const payloadTeam = canonicalHubTeam(payload.callerTeam);
  const contextTeam = canonicalHubTeam(context.callerTeam);
  if (payloadTeam && contextTeam && payloadTeam !== contextTeam) {
    const error = new Error('callerTeam_mismatch') as Error & { code?: string };
    error.code = 'callerTeam_mismatch';
    throw error;
  }
  const ownerTeam = contextTeam
    || payloadTeam
    || canonicalHubTeam((targetPolicy as any)?.target?.canonicalTeam || (targetPolicy as any)?.target?.team);
  if (!ownerTeam) {
    const error = new Error('llm_job_owner_required') as Error & { code?: string };
    error.code = 'llm_job_owner_required';
    throw error;
  }
  const ownerPrincipalId = String(context.authPrincipalId || '').trim() || null;
  const persistedPayload = { ...payload };
  if (ownerPrincipalId) persistedPayload.authPrincipalId = ownerPrincipalId;
  else delete persistedPayload.authPrincipalId;
  const job: LlmJob = {
    id: createJobId(),
    status: 'queued',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    traceId: context.traceId || payload.traceId || null,
    callerTeam: payload.callerTeam || context.callerTeam || null,
    ownerTeam,
    ownerPrincipalId,
    agent: payload.agent || context.agent || null,
    payload: persistedPayload,
    payloadSummary: summarizePayload(persistedPayload),
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

async function processJob(jobId: string, deps: ProcessJobDeps = {}): Promise<LlmJob | null> {
  if (activeJobs.has(jobId)) return readJob(jobId);
  const job = await readJob(jobId);
  if (!job || job.status === 'completed' || job.status === 'failed') return job;
  activeJobs.add(jobId);

  try {
    await updateJob(jobId, {
      status: 'running',
      startedAt: nowIso(),
      attempts: Number(job.attempts || 0) + 1,
    });

    const request = {
      ...job.payload,
      traceId: job.traceId || undefined,
      callerTeam: job.payload?.callerTeam || job.callerTeam || job.ownerTeam || undefined,
      agent: job.payload?.agent || job.agent || undefined,
    };
    const result = deps.callWithFallback
      ? await deps.callWithFallback(request)
      : shouldMockJobs()
      ? {
          ok: true,
          provider: 'mock',
          result: 'hub llm job smoke result',
          durationMs: 0,
          totalCostUsd: 0,
        }
      : await callWithFallback(request);

    if (!result?.ok && (
      result?.limiterBackpressure === true
      || String(result?.error || '').startsWith('shared_limiter_')
    )) {
      const retryAfterMs = Number(result?.retryAfterMs || JOB_RETRY_AFTER_MS);
      await updateJob(jobId, {
        status: 'queued',
        retryAfterMs,
        limiter: { error: result.error, admissionScope: result.admissionScope || null },
      });
      if (deps.scheduleJob) deps.scheduleJob(jobId, retryAfterMs);
      else setTimeout(() => scheduleJob(jobId), retryAfterMs).unref?.();
      return readJob(jobId);
    }

    await updateJob(jobId, {
      status: result?.ok ? 'completed' : 'failed',
      result: result?.ok ? result : null,
      error: result?.ok ? null : (result?.error || 'llm_job_failed'),
      providerBackpressure: buildJobBackpressure(result),
      finishedAt: nowIso(),
    });
    return readJob(jobId);
  } finally {
    activeJobs.delete(jobId);
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

function jobOwnerTeamAliases(callerTeam: string): string[] {
  const canonical = canonicalHubTeam(callerTeam);
  if (canonical === 'investment') return ['investment', 'luna'];
  if (canonical === 'orchestrator') return ['orchestrator', 'jay'];
  return canonical ? [canonical] : [];
}

function canReadLlmJob(job: LlmJob | null, owner: LlmJobOwner): boolean {
  if (!job || !owner?.callerTeam) return false;
  if (canonicalHubTeam(job.ownerTeam || job.callerTeam || job.payload?.callerTeam) !== canonicalHubTeam(owner.callerTeam)) {
    return false;
  }

  const requestedPrincipal = String(owner.authPrincipalId || '').trim();
  const storedPrincipal = String(job.ownerPrincipalId || '').trim();
  if (
    storedPrincipal
    && storedPrincipal !== 'legacy-root'
    && requestedPrincipal !== 'legacy-root'
    && storedPrincipal !== requestedPrincipal
  ) {
    return false;
  }
  return true;
}

function requireLlmJobOwner(owner: LlmJobOwner | null): LlmJobOwner {
  const callerTeam = canonicalHubTeam(owner?.callerTeam);
  if (!callerTeam) throw new Error('llm_job_owner_required');
  return {
    callerTeam,
    authPrincipalId: owner?.authPrincipalId || null,
  };
}

async function readOwnedLlmJob(jobId: string, owner: LlmJobOwner | null): Promise<LlmJob | null> {
  const normalizedOwner = requireLlmJobOwner(owner);
  const job = await readJob(jobId);
  return canReadLlmJob(job, normalizedOwner) ? job : null;
}

async function listOwnedLlmJobs(limit = 20, owner: LlmJobOwner | null): Promise<Array<Record<string, unknown>>> {
  const normalizedOwner = requireLlmJobOwner(owner);
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  if (jobStoreBackend() === 'pg') {
    await ensurePgJobTable();
    const pgPool = getPgPool();
    const teamAliases = jobOwnerTeamAliases(normalizedOwner.callerTeam);
    const scopedPrincipal = normalizedOwner.authPrincipalId && normalizedOwner.authPrincipalId !== 'legacy-root'
      ? normalizedOwner.authPrincipalId
      : null;
    const rows = await pgPool.query<{ job: LlmJob }>('agent', `
      SELECT job
      FROM hub_llm_jobs
      WHERE LOWER(BTRIM(COALESCE(job->>'ownerTeam', job->>'callerTeam', job #>> '{payload,callerTeam}', ''))) = ANY($1::text[])
      AND (
        $2::text IS NULL
        OR COALESCE(job->>'ownerPrincipalId', '') IN ('', 'legacy-root', $2)
      )
      ORDER BY updated_at DESC
      LIMIT $3
    `, [teamAliases, scopedPrincipal, normalizedLimit]);
    return rows
      .map((row) => row.job)
      .filter((job) => canReadLlmJob(job, normalizedOwner))
      .map((job) => summarizeJob(job));
  }

  ensureJobDir();
  const files = fs.readdirSync(JOB_DIR)
    .filter((name: string) => name.endsWith('.json'))
    .map((name: string) => path.join(JOB_DIR, name))
    .sort((a: string, b: string) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const jobs: Array<Record<string, unknown>> = [];
  for (const file of files) {
    try {
      const job = JSON.parse(fs.readFileSync(file, 'utf8')) as LlmJob;
      if (canReadLlmJob(job, normalizedOwner)) jobs.push(summarizeJob(job));
    } catch {
      // Ignore malformed files and continue looking for owned jobs.
    }
    if (jobs.length >= normalizedLimit) break;
  }
  return jobs;
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
  readJobForWorker: readJob,
  readOwnedLlmJob,
  listOwnedLlmJobs,
  processJob,
  getJobStoreState,
  resetJobStoreForTests,
};
