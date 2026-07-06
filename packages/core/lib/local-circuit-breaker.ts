// Circuit breaker for local Ollama/MLX LLM endpoints
// States: CLOSED (normal) → OPEN (skip) → HALF_OPEN (one test) → CLOSED

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_OPEN_DURATION_MS = 30_000;
const HUB_RESILIENCE_FAILURE_THRESHOLD = 5;
const HUB_RESILIENCE_OPEN_DURATION_MS = 60_000;

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface Circuit {
  state: CircuitState;
  failures: number;
  lastFailureAt: number;
  lastOpenAt: number;
}

const circuits = new Map<string, Circuit>();

function truthyEnv(name: string): boolean {
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(process.env[name] || '').trim().toLowerCase());
}

function configuredPositiveInt(name: string): number | null {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
}

function failureThreshold(): number {
  return configuredPositiveInt('HUB_PROVIDER_CIRCUIT_FAILURE_THRESHOLD')
    || configuredPositiveInt('HUB_RESILIENCE_CIRCUIT_FAILURE_THRESHOLD')
    || (truthyEnv('HUB_RESILIENCE_ENABLED') ? HUB_RESILIENCE_FAILURE_THRESHOLD : DEFAULT_FAILURE_THRESHOLD);
}

function openDurationMs(): number {
  return configuredPositiveInt('HUB_PROVIDER_CIRCUIT_OPEN_MS')
    || configuredPositiveInt('HUB_RESILIENCE_CIRCUIT_OPEN_MS')
    || (truthyEnv('HUB_RESILIENCE_ENABLED') ? HUB_RESILIENCE_OPEN_DURATION_MS : DEFAULT_OPEN_DURATION_MS);
}

function _get(baseUrl: string): Circuit {
  if (!circuits.has(baseUrl)) {
    circuits.set(baseUrl, { state: 'CLOSED', failures: 0, lastFailureAt: 0, lastOpenAt: 0 });
  }
  return circuits.get(baseUrl)!;
}

function _normalizeUrl(url: string): string {
  return String(url || '').replace(/\/+$/, '').toLowerCase() || 'default';
}

export function isCircuitOpen(baseUrl: string): boolean {
  const key = _normalizeUrl(baseUrl);
  const c = _get(key);

  if (c.state === 'CLOSED') return false;

  if (c.state === 'OPEN') {
    if (Date.now() - c.lastOpenAt > openDurationMs()) {
      c.state = 'HALF_OPEN';
      console.log(`[local-circuit] ${key}: OPEN → HALF_OPEN (testing)`);
      return false;
    }
    return true;
  }

  // HALF_OPEN: allow one probe through
  return false;
}

export function recordSuccess(baseUrl: string): void {
  const key = _normalizeUrl(baseUrl);
  const c = _get(key);
  if (c.state !== 'CLOSED') {
    console.log(`[local-circuit] ${key}: ${c.state} → CLOSED`);
  }
  c.state = 'CLOSED';
  c.failures = 0;
}

export function recordFailure(baseUrl: string): void {
  const key = _normalizeUrl(baseUrl);
  const c = _get(key);
  c.failures += 1;
  c.lastFailureAt = Date.now();

  if (c.state === 'HALF_OPEN') {
    c.state = 'OPEN';
    c.lastOpenAt = Date.now();
    console.warn(`[local-circuit] ${key}: HALF_OPEN → OPEN (probe failed)`);
    return;
  }

  if (c.state === 'CLOSED' && c.failures >= failureThreshold()) {
    c.state = 'OPEN';
    c.lastOpenAt = Date.now();
    console.warn(`[local-circuit] ${key}: CLOSED → OPEN (${c.failures} consecutive failures)`);
  }
}

export function getCircuitStatus(baseUrl: string): {
  state: CircuitState;
  failures: number;
  openSinceMs?: number;
  remainingMs?: number;
} {
  const key = _normalizeUrl(baseUrl);
  const c = _get(key);
  const openSinceMs = c.state !== 'CLOSED' ? Date.now() - c.lastOpenAt : undefined;
  const durationMs = openDurationMs();
  const remainingMs =
    c.state === 'OPEN' ? Math.max(0, durationMs - (Date.now() - c.lastOpenAt)) : undefined;
  return { state: c.state, failures: c.failures, openSinceMs, remainingMs };
}

export function getAllCircuitStatuses(): Record<string, ReturnType<typeof getCircuitStatus>> {
  const result: Record<string, ReturnType<typeof getCircuitStatus>> = {};
  for (const [url] of circuits) {
    result[url] = getCircuitStatus(url);
  }
  return result;
}

export function resetCircuit(baseUrl: string): void {
  const key = _normalizeUrl(baseUrl);
  circuits.delete(key);
  console.log(`[local-circuit] ${key}: 수동 리셋`);
}

export function resetAllCircuits(): string[] {
  const reset = Array.from(circuits.keys());
  circuits.clear();
  console.log(`[local-circuit] all circuits reset (${reset.length})`);
  return reset;
}
