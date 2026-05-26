'use strict';

const { postAlarm: defaultPostAlarm } = require('../../../../packages/core/lib/hub-alarm-client');

function readPositiveIntEnv(name, fallback, min, max) {
  const parsed = Number(process.env[name] || '');
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRetryDelayMs(value, maxDelayMs) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return Math.min(1000, maxDelayMs);
  return Math.max(1, Math.min(maxDelayMs, Math.trunc(parsed)));
}

function isRetryable(result) {
  return result?.retryable === true || Number(result?.status) === 429;
}

async function deliverScheduledAlarm(payload, options = {}) {
  const sendAlarm = options.postAlarm || defaultPostAlarm;
  const sleep = options.sleep || defaultSleep;
  const logger = options.logger || console;
  const maxAttempts = Math.max(
    1,
    Math.min(
      5,
      Math.trunc(options.maxAttempts || readPositiveIntEnv('HUB_SCHEDULED_ALARM_ATTEMPTS', 2, 1, 5)),
    ),
  );
  const maxDelayMs = Math.max(
    1,
    Math.min(
      60_000,
      Math.trunc(options.maxDelayMs || readPositiveIntEnv('HUB_SCHEDULED_ALARM_RETRY_MAX_DELAY_MS', 30_000, 1, 60_000)),
    ),
  );
  const deferRetryableFailure = options.deferRetryableFailure !== false;
  let lastResult = null;
  let lastError = null;
  let lastRetryable = false;
  let lastRetryAfterMs = null;
  let attemptsMade = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptsMade = attempt;
    lastResult = await sendAlarm(payload);
    if (lastResult?.ok === true) {
      return {
        ok: true,
        delivered: true,
        deferred: false,
        status: 'delivered',
        attempts: attempt,
        retryable: false,
        retryAfterMs: null,
        error: null,
        result: lastResult,
      };
    }

    lastError = String(lastResult?.error || 'hub_alarm_not_delivered');
    lastRetryable = isRetryable(lastResult);
    lastRetryAfterMs = lastRetryable ? normalizeRetryDelayMs(lastResult?.retryAfterMs, maxDelayMs) : null;

    if (!lastRetryable || attempt >= maxAttempts) break;

    logger.warn(`[hub-scheduled-delivery] retryable alarm failure (${lastError}) — retry ${attempt + 1}/${maxAttempts} in ${lastRetryAfterMs}ms`);
    await sleep(lastRetryAfterMs);
  }

  if (deferRetryableFailure && lastRetryable) {
    return {
      ok: true,
      delivered: false,
      deferred: true,
      status: 'deferred_retryable_failure',
      attempts: attemptsMade,
      retryable: true,
      retryAfterMs: lastRetryAfterMs,
      error: lastError,
      result: lastResult,
    };
  }

  return {
    ok: false,
    delivered: false,
    deferred: false,
    status: 'failed',
    attempts: attemptsMade,
    retryable: lastRetryable,
    retryAfterMs: lastRetryAfterMs,
    error: lastError,
    result: lastResult,
  };
}

module.exports = {
  deliverScheduledAlarm,
};
