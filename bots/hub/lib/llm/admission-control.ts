function parseEnvNumber(name, fallback, minValue) {
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

let inFlight = 0;
const waiters = [];

function createAdmissionError(code, message, retryAfterMs = DEFAULT_RETRY_AFTER_MS) {
  const error = new Error(message);
  error.code = code;
  error.retryAfterMs = retryAfterMs;
  return error;
}

function dequeueById(waiterId) {
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

async function acquireSlot(req) {
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

  await new Promise((resolve, reject) => {
    const waiter = {
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

async function acquireSharedLeaseOrReleaseLocal(req) {
  const sharedLease = await acquireSharedLimiterLease({
    team: req.body?.callerTeam || req.hubRequestContext?.callerTeam || 'unknown',
    provider: req.body?.provider || '',
  });
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

function releaseSlot() {
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

async function llmAdmissionMiddleware(req, res, next) {
  try {
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
    const err = error;
    if (err.code === 'client_disconnected') {
      return;
    }
    const retryAfterMs = Math.max(0, Number(err.retryAfterMs || DEFAULT_RETRY_AFTER_MS) || DEFAULT_RETRY_AFTER_MS);
    if (retryAfterMs > 0) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
    }
    const status = err.code === 'queue_full' ? 429 : 503;
    if (err.code === 'queue_full' && shouldOverflowToJob(req)) {
      try {
        const { createLlmJob } = require('./job-store');
        const job = createLlmJob(req.body || {}, req.hubRequestContext || {}, { source: 'admission_overflow' });
        res.set('Retry-After', String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
        return res.status(202).json({
          ok: true,
          queued: true,
          jobId: job.id,
          status: job.status,
          statusUrl: `/hub/llm/jobs/${job.id}`,
          overflow: {
            reason: err.code,
            retryAfterMs,
          },
        });
      } catch (jobError) {
        return res.status(503).json({
          ok: false,
          error: {
            code: 'job_enqueue_failed',
            message: jobError?.message || 'failed to enqueue LLM job',
          },
          retryAfterMs,
        });
      }
    }
    return res.status(status).json({
      ok: false,
      error: {
        code: err.code || 'admission_rejected',
        message: err.message || 'admission rejected',
      },
      retryAfterMs,
      inFlight,
      queueDepth: waiters.length,
    });
  }
}

function shouldOverflowToJob(req) {
  const enabled = ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env.HUB_LLM_OVERFLOW_TO_JOB || '').trim().toLowerCase());
  if (!enabled) return false;
  return req.method === 'POST' && req.path === '/hub/llm/call' && req.body && typeof req.body.prompt === 'string';
}

module.exports = {
  llmAdmissionMiddleware,
  getLlmAdmissionState,
};
