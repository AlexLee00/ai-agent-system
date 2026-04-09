import { N8N_ENABLED } from './env';

const DEFAULT_HEALTH_TIMEOUT_MS = Number(process.env.N8N_HEALTH_TIMEOUT_MS || 2500);
const DEFAULT_WEBHOOK_TIMEOUT_MS = Number(process.env.N8N_WEBHOOK_TIMEOUT_MS || 30000);
const DEFAULT_BACKOFF_MS = 30 * 60 * 1000;

type CircuitState = {
  disabledUntil: number;
  reason: string;
};

type TriggerFailure = {
  url: string;
  status?: number;
  reason: string;
};

type TriggerSuccess = {
  ok: true;
  url: string;
  status: number;
  body: Record<string, unknown> | null;
};

type TriggerSkipped = {
  ok: false;
  skipped: true;
  reason: 'n8n_not_available_in_dev';
  failures: TriggerFailure[];
};

type TriggerFailureResult = {
  ok: false;
  url?: string;
  status?: number;
  reason: string;
  failures: TriggerFailure[];
};

type TriggerResult = TriggerSuccess | TriggerSkipped | TriggerFailureResult;

type LoggerLike = Pick<Console, 'log' | 'warn'>;

type TriggerWebhookCandidatesArgs = {
  candidates?: Array<string | null | undefined>;
  body: unknown;
  timeoutMs?: number;
  headers?: Record<string, string>;
};

type DirectRunnerResult = Record<string, unknown>;
type DirectRunner = () => Promise<DirectRunnerResult> | DirectRunnerResult;

type RunWithN8nFallbackArgs = {
  circuitName: string;
  webhookCandidates?: Array<string | null | undefined>;
  healthUrl?: string | null;
  body: unknown;
  directRunner: DirectRunner;
  headers?: Record<string, string>;
  webhookTimeoutMs?: number;
  healthTimeoutMs?: number;
  backoffMs?: number;
  logger?: LoggerLike;
};

const circuits = new Map<string, CircuitState>();

function getCircuit(name: string): CircuitState {
  let circuit = circuits.get(name);
  if (!circuit) {
    circuit = { disabledUntil: 0, reason: '' };
    circuits.set(name, circuit);
  }
  return circuit;
}

export function isCircuitOpen(name: string): boolean {
  return getCircuit(name).disabledUntil > Date.now();
}

export function openCircuit(name: string, reason: string, backoffMs = DEFAULT_BACKOFF_MS): void {
  const circuit = getCircuit(name);
  circuit.disabledUntil = Date.now() + backoffMs;
  circuit.reason = reason;
}

export function resetCircuit(name: string): void {
  const circuit = getCircuit(name);
  circuit.disabledUntil = 0;
  circuit.reason = '';
}

export function getCircuitState(name: string): { open: boolean; disabledUntil: number; reason: string } {
  const circuit = getCircuit(name);
  return {
    open: circuit.disabledUntil > Date.now(),
    disabledUntil: circuit.disabledUntil,
    reason: circuit.reason,
  };
}

export async function probeN8nHealth(
  healthUrl?: string | null,
  timeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
): Promise<boolean> {
  if (!healthUrl) return false;
  try {
    const res = await fetch(healthUrl, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function triggerWebhookCandidates({
  candidates,
  body,
  timeoutMs = DEFAULT_WEBHOOK_TIMEOUT_MS,
  headers = {},
}: TriggerWebhookCandidatesArgs): Promise<TriggerResult> {
  if (!N8N_ENABLED) {
    return { ok: false, skipped: true, reason: 'n8n_not_available_in_dev', failures: [] };
  }

  const failures: TriggerFailure[] = [];
  const uniqueCandidates = [...new Set((candidates || []).filter(Boolean))] as string[];

  for (const url of uniqueCandidates) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (res.ok) {
        const text = await res.text();
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
        } catch {
          parsed = { raw: text };
        }
        return { ok: true, url, status: res.status, body: parsed };
      }

      if (res.status === 404) {
        failures.push({ url, status: res.status, reason: 'not_registered' });
        continue;
      }

      failures.push({ url, status: res.status, reason: `http_${res.status}` });
      return { ok: false, url, status: res.status, reason: `http_${res.status}`, failures };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'request_failed';
      failures.push({ url, reason: String(reason) });
    }
  }

  const onlyNotRegistered = failures.length > 0 && failures.every((item) => item.reason === 'not_registered');
  return {
    ok: false,
    reason: onlyNotRegistered ? 'webhook_not_registered' : 'webhook_unavailable',
    failures,
  };
}

export async function runWithN8nFallback({
  circuitName,
  webhookCandidates,
  healthUrl,
  body,
  directRunner,
  headers = {},
  webhookTimeoutMs = DEFAULT_WEBHOOK_TIMEOUT_MS,
  healthTimeoutMs = DEFAULT_HEALTH_TIMEOUT_MS,
  backoffMs = DEFAULT_BACKOFF_MS,
  logger = console,
}: RunWithN8nFallbackArgs): Promise<Record<string, unknown>> {
  if (!N8N_ENABLED) {
    logger.log('[n8n-runner] DEV 환경 — n8n 미설치, 스킵');
    const directResult = typeof directRunner === 'function' ? await directRunner() : {};
    return {
      ok: false,
      skipped: true,
      source: 'direct',
      reason: 'n8n_not_available_in_dev',
      ...directResult,
    };
  }

  const state = getCircuitState(circuitName);
  if (state.open) {
    logger.log(`[n8n] 우회 중 (${circuitName}: ${state.reason})`);
    return directRunner();
  }

  const healthy = await probeN8nHealth(healthUrl, healthTimeoutMs);
  if (!healthy) {
    openCircuit(circuitName, 'health_unreachable', backoffMs);
    logger.warn(`[n8n] 헬스체크 실패 (${circuitName}) — direct fallback`);
    return directRunner();
  }

  const triggered = await triggerWebhookCandidates({
    candidates: webhookCandidates,
    body,
    timeoutMs: webhookTimeoutMs,
    headers,
  });

  if (triggered.ok) {
    resetCircuit(circuitName);
    return {
      ok: true,
      source: 'n8n',
      webhookUrl: triggered.url,
      statusCode: triggered.status,
      ...(triggered.body && typeof triggered.body === 'object' ? triggered.body : {}),
    };
  }

  openCircuit(circuitName, triggered.reason || 'webhook_failed', backoffMs);
  const detail =
    Array.isArray(triggered.failures) && triggered.failures.length > 0
      ? ` [${triggered.failures.map((item) => `${item.url}:${item.reason}`).join(', ')}]`
      : '';
  logger.warn(`[n8n] 웹훅 실패 (${circuitName}: ${triggered.reason || 'unknown'})${detail} — direct fallback`);
  return directRunner();
}
