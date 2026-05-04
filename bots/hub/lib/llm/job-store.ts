const fs = require('node:fs');
const path = require('node:path');
const { callWithFallback } = require('./unified-caller');
const { acquireSharedLimiterLease } = require('./shared-limiter');

const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
const JOB_DIR = process.env.HUB_LLM_JOB_DIR || path.join(repoRoot, 'bots/hub/output/llm-jobs');
const JOB_RETRY_AFTER_MS = Number(process.env.HUB_LLM_JOB_RETRY_AFTER_MS || 1_000);
const activeJobs = new Set();

function ensureJobDir() {
  fs.mkdirSync(JOB_DIR, { recursive: true });
}

function jobPath(jobId) {
  return path.join(JOB_DIR, `${String(jobId || '').replace(/[^a-zA-Z0-9_.:-]+/g, '_')}.json`);
}

function nowIso() {
  return new Date().toISOString();
}

function createJobId() {
  return `llm_job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function writeJob(job) {
  ensureJobDir();
  const file = jobPath(job.id);
  fs.writeFileSync(file, JSON.stringify(job, null, 2));
  return job;
}

function readJob(jobId) {
  try {
    const job = JSON.parse(fs.readFileSync(jobPath(jobId), 'utf8'));
    return job && job.id ? job : null;
  } catch {
    return null;
  }
}

function updateJob(jobId, patch) {
  const current = readJob(jobId);
  if (!current) return null;
  return writeJob({
    ...current,
    ...patch,
    updatedAt: nowIso(),
  });
}

function summarizePayload(payload = {}) {
  return {
    callerTeam: payload.callerTeam || null,
    agent: payload.agent || null,
    selectorKey: payload.selectorKey || null,
    abstractModel: payload.abstractModel || null,
    promptBytes: Buffer.byteLength(String(payload.prompt || ''), 'utf8'),
  };
}

function createLlmJob(payload, context = {}, options = {}) {
  const job = {
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
  writeJob(job);
  if (options.start !== false) scheduleJob(job.id);
  return job;
}

function scheduleJob(jobId) {
  if (activeJobs.has(jobId)) return;
  setImmediate(() => {
    processJob(jobId).catch((error) => {
      updateJob(jobId, {
        status: 'failed',
        error: error?.message || String(error),
        finishedAt: nowIso(),
      });
    });
  });
}

async function processJob(jobId) {
  if (activeJobs.has(jobId)) return readJob(jobId);
  const job = readJob(jobId);
  if (!job || job.status === 'completed' || job.status === 'failed') return job;
  activeJobs.add(jobId);

  let lease = null;
  try {
    lease = await acquireSharedLimiterLease({
      team: job.callerTeam || job.payload?.callerTeam || 'unknown',
      provider: job.payload?.provider || '',
    });
    if (!lease.ok) {
      updateJob(jobId, {
        status: 'queued',
        retryAfterMs: lease.retryAfterMs || JOB_RETRY_AFTER_MS,
        limiter: lease,
      });
      setTimeout(() => scheduleJob(jobId), lease.retryAfterMs || JOB_RETRY_AFTER_MS).unref?.();
      return readJob(jobId);
    }

    updateJob(jobId, {
      status: 'running',
      startedAt: nowIso(),
      attempts: Number(job.attempts || 0) + 1,
      limiter: { scopes: lease.scopes || [], skipped: Boolean(lease.skipped) },
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

    updateJob(jobId, {
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

function buildJobBackpressure(result) {
  const error = String(result?.error || '').toLowerCase();
  if (!error) return null;
  if (error.includes('429') || error.includes('rate limit') || error.includes('quota')) {
    return { kind: 'provider_rate_limit', retryAfterMs: 60_000 };
  }
  if (error.includes('provider_cooldown')) return { kind: 'provider_cooldown', retryAfterMs: 60_000 };
  if (error.includes('provider_circuit_open')) return { kind: 'provider_circuit_open', retryAfterMs: 15_000 };
  return null;
}

function shouldMockJobs() {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env.HUB_LLM_JOB_SMOKE_MOCK || '').trim().toLowerCase());
}

function listLlmJobs(limit = 20) {
  ensureJobDir();
  const files = fs.readdirSync(JOB_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(JOB_DIR, name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));
  return files.map((file) => {
    try {
      const job = JSON.parse(fs.readFileSync(file, 'utf8'));
      return {
        id: job.id,
        status: job.status,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        traceId: job.traceId || null,
        payloadSummary: job.payloadSummary || summarizePayload(job.payload),
      };
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function getJobStoreState() {
  return {
    dir: JOB_DIR,
    active: activeJobs.size,
  };
}

function resetJobStoreForTests() {
  activeJobs.clear();
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
