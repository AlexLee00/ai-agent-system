type AdmissionRequest = {
  body?: {
    callerTeam?: string;
    provider?: string;
    prompt?: unknown;
  } & Record<string, unknown>;
  hubRequestContext?: {
    callerTeam?: string;
    cycleId?: string;
    cycle_id?: string;
  } & Record<string, unknown>;
  headers?: Record<string, unknown>;
  method?: string;
  path?: string;
  once(event: string, listener: () => void): unknown;
};

type AdmissionResponse = {
  locals?: Record<string, unknown>;
  on(event: string, listener: () => void): unknown;
  set(name: string, value: string): unknown;
  status(code: number): AdmissionResponse;
  json(payload: unknown): unknown;
};

type NextFunction = () => unknown;

type AdmissionError = Error & {
  code: string;
  retryAfterMs: number;
};

type SharedLease = {
  ok: boolean;
  reason?: string;
  scope?: string;
  retryAfterMs?: number;
  release?: () => void;
};

type Waiter = {
  id: string;
  resolve: () => void;
  reject: (error: Error) => void;
  queuedAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  completed: boolean;
};

function parseEnvNumber(name: string, fallback: number, minValue: number): number {
  const raw = process.env[name];
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minValue, Math.floor(parsed));
}

const DEFAULT_MAX_IN_FLIGHT = parseEnvNumber('HUB_LLM_MAX_IN_FLIGHT', 16, 1);
const DEFAULT_MAX_QUEUE = parseEnvNumber('HUB_LLM_MAX_QUEUE', 128, 0);
const DEFAULT_QUEUE_TIMEOUT_MS = parseEnvNumber('HUB_LLM_QUEUE_TIMEOUT_MS', 15000, 100);
const DEFAULT_RETRY_AFTER_MS = parseEnvNumber('HUB_LLM_RETRY_AFTER_MS', 1000, 200);
const { acquireSharedLimiterLease, getSharedLimiterState } = require('./shared-limiter');
const {
  buildCycleBudgetReport,
  cycleGuardMode,
  normalizeCycleId,
  summarizeCycleBudget,
} = require('./cycle-budget');

let inFlight = 0;
const waiters: Waiter[] = [];

function createAdmissionError(code: string, message: string, retryAfterMs = DEFAULT_RETRY_AFTER_MS): AdmissionError {
  return Object.assign(new Error(message), { code, retryAfterMs });
}

function dequeueById(waiterId: string): Waiter | null {
  const index = waiters.findIndex((entry) => entry.id === waiterId);
  if (index < 0) return null;
  const [entry] = waiters.splice(index, 1);
  return entry || null;
}

function drainQueue() {
  while (inFlight < DEFAULT_MAX_IN_FLIGHT && waiters.length > 0) {
    const next = waiters.shift();
    if (!next || next.completed) continue;
    next.completed = true;
    if (next.timer) clearTimeout(next.timer);
    inFlight += 1;
    next.resolve();
  }
}

async function acquireSlot(req: AdmissionRequest): Promise<{ queued: boolean; sharedLease: SharedLease }> {
  if (inFlight < DEFAULT_MAX_IN_FLIGHT) {
    inFlight += 1;
    const sharedLease = await acquireSharedLeaseOrReleaseLocal(req);
    return { queued: false, sharedLease };
  }

  if (waiters.length >= DEFAULT_MAX_QUEUE) {
    throw createAdmissionError(
      'queue_full',
      `LLM admission queue is full (${waiters.length}/${DEFAULT_MAX_QUEUE})`,
      DEFAULT_RETRY_AFTER_MS,
    );
  }

  const waiterId = `wait_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  await new Promise<void>((resolve, reject) => {
    const waiter: Waiter = {
      id: waiterId,
      resolve,
      reject,
      queuedAt: Date.now(),
      timer: null,
      completed: false,
    };
    waiter.timer = setTimeout(() => {
      const removed = dequeueById(waiterId);
      if (!removed || removed.completed) return;
      removed.completed = true;
      removed.reject(createAdmissionError('queue_timeout', 'LLM admission queue wait timeout', DEFAULT_RETRY_AFTER_MS));
    }, DEFAULT_QUEUE_TIMEOUT_MS);
    waiter.timer.unref?.();
    waiters.push(waiter);

    const onClientClose = () => {
      const removed = dequeueById(waiterId);
      if (!removed || removed.completed) return;
      removed.completed = true;
      if (removed.timer) clearTimeout(removed.timer);
      removed.reject(createAdmissionError('client_disconnected', 'request aborted while queued', 0));
    };

    req.once('aborted', onClientClose);
    req.once('close', onClientClose);
  });

  const sharedLease = await acquireSharedLeaseOrReleaseLocal(req);
  return { queued: true, sharedLease };
}

async function acquireSharedLeaseOrReleaseLocal(req: AdmissionRequest): Promise<SharedLease> {
  const sharedLease = await acquireSharedLimiterLease({
    team: req.body?.callerTeam || req.hubRequestContext?.callerTeam || 'unknown',
    provider: req.body?.provider || '',
  }) as SharedLease;
  if (!sharedLease.ok) {
    releaseSlot();
    throw createAdmissionError(
      sharedLease.reason || 'shared_limiter_full',
      `LLM shared limiter rejected scope ${sharedLease.scope || 'unknown'}`,
      sharedLease.retryAfterMs || DEFAULT_RETRY_AFTER_MS,
    );
  }
  return sharedLease;
}

function releaseSlot(): void {
  if (inFlight > 0) inFlight -= 1;
  drainQueue();
}

function getLlmAdmissionState() {
  return {
    in_flight: inFlight,
    queued: waiters.length,
    limits: {
      max_in_flight: DEFAULT_MAX_IN_FLIGHT,
      max_queue: DEFAULT_MAX_QUEUE,
      queue_timeout_ms: DEFAULT_QUEUE_TIMEOUT_MS,
    },
    shared_limiter: getSharedLimiterState(),
  };
}

function errorCode(error: unknown, fallback = 'admission_rejected'): string {
  const code = (error as Partial<AdmissionError> | null)?.code;
  return typeof code === 'string' && code ? code : fallback;
}

function errorRetryAfterMs(error: unknown): number {
  const retryAfterMs = Number((error as Partial<AdmissionError> | null)?.retryAfterMs || DEFAULT_RETRY_AFTER_MS);
  return Math.max(0, Number.isFinite(retryAfterMs) ? retryAfterMs : DEFAULT_RETRY_AFTER_MS);
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function requestCycleId(req: AdmissionRequest): string {
  const headers = req.headers || {};
  return normalizeCycleId(
    req.body?.cycleId
      || req.body?.cycle_id
      || req.hubRequestContext?.cycleId
      || req.hubRequestContext?.cycle_id
      || headers['x-hub-cycle-id']
      || headers['X-Hub-Cycle-Id'],
  );
}

async function evaluateCycleBudgetGuard(req: AdmissionRequest, res: AdmissionResponse): Promise<boolean> {
  const mode = cycleGuardMode();
  if (mode === 'off') return true;
  const cycleId = requestCycleId(req);
  if (!cycleId) return true;

  const report = await buildCycleBudgetReport(cycleId);
  res.locals = res.locals || {};
  res.locals.hubCycleBudget = report;
  const summary = summarizeCycleBudget(report);
  if (summary) {
    res.set('X-Hub-Cycle-Budget-Warn', summary);
    console.warn(`[hub-cycle-budget] ${summary} cycle=${cycleId}`);
  }
  if (mode === 'enforce' && report && report.ok === false) {
    res.set('Retry-After', '60');
    res.status(429).json({
      ok: false,
      error: {
        code: 'cycle_budget_exceeded',
        message: 'Hub cycle budget exceeded',
      },
      cycleBudget: {
        cycleId: report.cycleId,
        metrics: report.metrics,
        blockers: report.blockers,
      },
      retryAfterMs: 60000,
    });
    return false;
  }
  return true;
}

async function llmAdmissionMiddleware(req: AdmissionRequest, res: AdmissionResponse, next: NextFunction) {
  try {
    const cycleOk = await evaluateCycleBudgetGuard(req, res);
    if (!cycleOk) return;

    const acquired = await acquireSlot(req);
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      acquired.sharedLease?.release?.();
      releaseSlot();
    };

    res.on('finish', releaseOnce);
    res.on('close', releaseOnce);
    res.set('X-Hub-LLM-InFlight', String(inFlight));
    res.set('X-Hub-LLM-QueueDepth', String(waiters.length));
    res.locals = res.locals || {};
    res.locals.llmAdmissionQueued = acquired.queued;
    return next();
  } catch (error) {
    const code = errorCode(error);
    if (code === 'client_disconnected') {
      return;
    }
    const retryAfterMs = errorRetryAfterMs(error);
    if (retryAfterMs > 0) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    }
    const status = code === 'queue_full' ? 429 : 503;
    if (code === 'queue_full' && shouldOverflowToJob(req)) {
      try {
        const { createLlmJob } = require('./job-store');
        const job = await createLlmJob(req.body || {}, req.hubRequestContext || {}, { source: 'admission_overflow' });
        res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
        return res.status(202).json({
          ok: true,
          queued: true,
          jobId: job.id,
          status: job.status,
          statusUrl: `/hub/llm/jobs/${job.id}`,
          overflow: {
            reason: code,
            retryAfterMs,
          },
        });
      } catch (jobError) {
        return res.status(503).json({
          ok: false,
          error: {
            code: 'job_enqueue_failed',
            message: errorMessage(jobError, 'failed to enqueue LLM job'),
          },
          retryAfterMs,
        });
      }
    }
    return res.status(status).json({
      ok: false,
      error: {
        code,
        message: errorMessage(error, 'admission rejected'),
      },
      retryAfterMs,
      inFlight,
      queueDepth: waiters.length,
    });
  }
}

function shouldOverflowToJob(req: AdmissionRequest): boolean {
  const enabled = ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env.HUB_LLM_OVERFLOW_TO_JOB || '').trim().toLowerCase());
  if (!enabled) return false;
  return Boolean(req.method === 'POST' && req.path === '/hub/llm/call' && req.body && typeof req.body.prompt === 'string');
}

module.exports = {
  llmAdmissionMiddleware,
  getLlmAdmissionState,
};
