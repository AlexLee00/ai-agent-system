import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hubAlarm = require('../../../packages/core/lib/hub-alarm-client.js') as {
  postAlarm: (input: Record<string, unknown>) => Promise<unknown>;
};

export type SigmaAlarmDispatchResult = {
  attempts: number;
  result: unknown;
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
    source: row.source,
    delivered: row.delivered,
    suppressed: row.suppressed,
    error: row.error,
    fallback: row.fallback,
  };
}

export async function postSigmaAlarmWithRetry(
  input: Record<string, unknown>,
  options: { attempts?: number; retryDelayMs?: number } = {},
): Promise<SigmaAlarmDispatchResult> {
  const maxAttempts = Math.max(1, Math.floor(options.attempts ?? 3));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? 2000));
  let lastResult: unknown = null;
  const capturedWarnings: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const posted = await postAlarmCapturingWarnings(input);
    lastResult = posted.result;
    capturedWarnings.push(...posted.warnings);
    if ((lastResult as { ok?: boolean } | null)?.ok === true) {
      return { attempts: attempt, result: lastResult };
    }
    const error = String((lastResult as { error?: unknown } | null)?.error || '');
    const shouldRetry = /timeout|aborted|network|ECONNRESET|ETIMEDOUT/i.test(error);
    if (!shouldRetry || attempt >= maxAttempts) break;
    await sleep(retryDelayMs);
  }

  for (const warning of capturedWarnings) {
    console.warn(warning);
  }
  return { attempts: maxAttempts, result: lastResult };
}
