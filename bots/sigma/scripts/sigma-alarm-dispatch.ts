import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hubAlarm = require('../../../packages/core/lib/hub-alarm-client.js') as {
  postAlarm: (input: Record<string, unknown>) => Promise<unknown>;
};

export type SigmaAlarmDispatchResult = {
  attempts: number;
  result: unknown;
};

type SigmaAlarmDispatchOptions = {
  attempts?: number;
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
};

function normalizeSigmaAlarmInput(input: Record<string, unknown>): Record<string, unknown> {
  const payload = input?.payload && typeof input.payload === 'object'
    ? input.payload as Record<string, unknown>
    : {};
  const team = String(input?.team || payload?.team || 'sigma');
  const fromBot = String(input?.fromBot || input?.bot || payload?.fromBot || payload?.bot || 'sigma-dispatch');
  const message = String(input?.message || payload?.message || '');
  const eventType = String(
    input?.eventType
    || input?.event_type
    || payload?.eventType
    || payload?.event_type
    || 'sigma_alarm',
  );
  const incidentKey = String(
    input?.incidentKey
    || input?.incident_key
    || payload?.incidentKey
    || payload?.incident_key
    || `${team}:${fromBot}:${eventType}`,
  );

  return {
    ...input,
    team,
    fromBot,
    message,
    eventType,
    incidentKey,
    alarmType: input?.alarmType || input?.alarm_type || 'report',
    visibility: input?.visibility || 'notify',
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name] || '');
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.trunc(parsed);
}

function resultRecord(result: unknown): Record<string, unknown> {
  return result && typeof result === 'object' ? result as Record<string, unknown> : {};
}

function isRetryableAlarmFailure(result: unknown): boolean {
  const row = resultRecord(result);
  if (row.retryable === true) return true;
  const status = Number(row.status);
  if (status === 429 || (Number.isFinite(status) && status >= 500)) return true;
  const error = String(row.error || '');
  return /timeout|aborted|network|ECONNRESET|ETIMEDOUT|rate limit|too many requests|hub_alarm_client_circuit_open/i.test(error);
}

function retryDelayFromResult(result: unknown, fallbackMs: number, maxRetryDelayMs: number): number {
  const row = resultRecord(result);
  const retryAfterMs = Number(row.retryAfterMs ?? row.retry_after_ms ?? 0);
  const rawDelay = Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? Math.trunc(retryAfterMs)
    : fallbackMs;
  return Math.max(0, Math.min(rawDelay, maxRetryDelayMs));
}

async function postAlarmCapturingWarnings(input: Record<string, unknown>): Promise<{
  result: unknown;
  warnings: string[];
}> {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    const normalizedInput = normalizeSigmaAlarmInput(input);
    return {
      result: await hubAlarm.postAlarm({
        ...normalizedInput,
        alarmType: normalizedInput.alarmType,
        visibility: normalizedInput.visibility,
        eventType: normalizedInput.eventType,
        incidentKey: normalizedInput.incidentKey,
      }),
      warnings,
    };
  } finally {
    console.warn = originalWarn;
  }
}

export function summarizeAlarmResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const row = result as Record<string, unknown>;
  return {
    ok: row.ok,
    status: row.status,
    source: row.source,
    delivered: row.delivered,
    suppressed: row.suppressed,
    error: row.error,
    fallback: row.fallback,
    retryable: row.retryable,
    retryAfterMs: row.retryAfterMs,
  };
}

export async function postSigmaAlarmWithRetry(
  input: Record<string, unknown>,
  options: SigmaAlarmDispatchOptions = {},
): Promise<SigmaAlarmDispatchResult> {
  const maxAttempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 2000));
  const maxRetryDelayMs = Math.max(
    0,
    Math.floor(options.maxRetryDelayMs ?? readPositiveIntEnv('SIGMA_ALARM_MAX_RETRY_DELAY_MS', 120_000)),
  );
  let lastResult: unknown = null;
  let actualAttempts = 0;
  const capturedWarnings: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    actualAttempts = attempt;
    const posted = await postAlarmCapturingWarnings(input);
    lastResult = posted.result;
    capturedWarnings.push(...posted.warnings);
    if ((lastResult as { ok?: boolean } | null)?.ok === true) {
      return { attempts: attempt, result: lastResult };
    }
    const shouldRetry = isRetryableAlarmFailure(lastResult);
    if (!shouldRetry || attempt >= maxAttempts) break;
    await sleep(retryDelayFromResult(lastResult, retryDelayMs, maxRetryDelayMs));
  }

  for (const warning of capturedWarnings) {
    console.warn(warning);
  }
  return { attempts: actualAttempts, result: lastResult };
}
