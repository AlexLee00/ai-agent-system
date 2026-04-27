// Circuit breaker for local Ollama/MLX LLM endpoints
// States: CLOSED (normal) → OPEN (skip) → HALF_OPEN (one test) → CLOSED

const FAILURE_THRESHOLD = 3;
const OPEN_DURATION_MS = 30_000;

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

interface Circuit {
  state: CircuitState;
  failures: number;
  lastFailureAt: number;
  lastOpenAt: number;
}

const circuits = new Map<string, Circuit>();

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
    if (Date.now() - c.lastOpenAt > OPEN_DURATION_MS) {
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

  if (c.state === 'CLOSED' && c.failures >= FAILURE_THRESHOLD) {
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
  const remainingMs =
    c.state === 'OPEN' ? Math.max(0, OPEN_DURATION_MS - (Date.now() - c.lastOpenAt)) : undefined;
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
