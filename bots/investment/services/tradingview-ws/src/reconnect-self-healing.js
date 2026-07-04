export const DEFAULT_LONG_RETRY_INTERVAL_MS = 300_000;
export const DEFAULT_LONG_RETRY_GIVEUP_MS = 21_600_000;

export function positiveInt(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

export function createLongRetryState(nowMs = null) {
  return {
    startedAt: nowMs,
    attempts: 0,
  };
}

export function resetLongRetryState(state = {}) {
  state.startedAt = null;
  state.attempts = 0;
  return state;
}

export function buildReconnectPlan({
  reconnectAttempts = 0,
  maxReconnectAttempts = 10,
  baseDelayMs = 2000,
  maxDelayMs = 60_000,
  longRetryState = {},
  longRetryIntervalMs = DEFAULT_LONG_RETRY_INTERVAL_MS,
  longRetryGiveupMs = DEFAULT_LONG_RETRY_GIVEUP_MS,
  nowMs = Date.now(),
} = {}) {
  const attempts = Math.max(0, Number(reconnectAttempts || 0));
  const maxAttempts = Math.max(0, Number(maxReconnectAttempts || 0));
  const startedAt = Number(longRetryState?.startedAt || 0);
  const longAttempts = Math.max(0, Number(longRetryState?.attempts || 0));
  const longInterval = positiveInt(longRetryIntervalMs, DEFAULT_LONG_RETRY_INTERVAL_MS);
  const longGiveup = positiveInt(longRetryGiveupMs, DEFAULT_LONG_RETRY_GIVEUP_MS);

  if (attempts >= maxAttempts) {
    const effectiveStartedAt = startedAt > 0 ? startedAt : nowMs;
    if (startedAt > 0 && nowMs - startedAt >= longGiveup) {
      return {
        mode: 'exit',
        delayMs: 0,
        metricType: 'failed',
        longRetryState: {
          startedAt: effectiveStartedAt,
          attempts: longAttempts,
        },
      };
    }
    return {
      mode: 'long_retry',
      delayMs: longInterval,
      metricType: 'long_retry',
      longRetryState: {
        startedAt: effectiveStartedAt,
        attempts: longAttempts + 1,
      },
    };
  }

  return {
    mode: 'scheduled',
    delayMs: Math.min(maxDelayMs, positiveInt(baseDelayMs, 2000) * Math.pow(2, attempts)),
    nextReconnectAttempts: attempts + 1,
    metricType: 'scheduled',
    longRetryState: resetLongRetryState({ ...longRetryState }),
  };
}
