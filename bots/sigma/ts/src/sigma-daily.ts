/**
 * Sigma Daily — v2 Thin Adapter (Phase 5)
 *
 * v1 로직은 docs/archive/sigma-legacy/ 로 이관됨.
 * Elixir v2 Commander를 HTTP로 호출하는 adapter.
 */

const CANONICAL_SIGMA_HTTP_PORT = '4000';
const SIGMA_HTTP_PORT = process.env.SIGMA_HTTP_PORT || CANONICAL_SIGMA_HTTP_PORT;
const SIGMA_V2_ENDPOINT =
  process.env.SIGMA_V2_ENDPOINT || `http://127.0.0.1:${SIGMA_HTTP_PORT}/sigma/v2`;

function sigmaEndpointCandidates(): string[] {
  if (process.env.SIGMA_V2_ENDPOINT) return [process.env.SIGMA_V2_ENDPOINT];
  const canonical = `http://127.0.0.1:${CANONICAL_SIGMA_HTTP_PORT}/sigma/v2`;
  return SIGMA_V2_ENDPOINT === canonical ? [SIGMA_V2_ENDPOINT] : [SIGMA_V2_ENDPOINT, canonical];
}

async function fetchSigmaJson(path: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<any> {
  let lastError: any = null;
  const { signal: _signal, ...baseInit } = init;
  for (const endpoint of sigmaEndpointCandidates()) {
    try {
      const response = await fetch(`${endpoint}${path}`, {
        ...baseInit,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || `HTTP ${response.status}`);
      }
      return data;
    } catch (error: any) {
      lastError = error;
    }
  }
  throw lastError || new Error('sigma_endpoint_unavailable');
}

export async function runDaily(options: { test?: boolean } = {}): Promise<any> {
  return fetchSigmaJson('/run-daily', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ test: options.test || false }),
  }, 120_000);
}

export async function checkHealth(): Promise<any> {
  return fetchSigmaJson('/health', {}, 10_000);
}

const isEntrypoint = (() => {
  const entry = process.argv[1];
  return typeof entry === 'string' && import.meta.url === `file://${entry}`;
})();

if (isEntrypoint) {
  const args = process.argv.slice(2);
  const runner = args.includes('--health')
    ? checkHealth()
    : runDaily({ test: args.includes('--test') });

  runner
      .then((r) => {
        console.log(JSON.stringify(r, null, 2));
        process.exit(0);
      })
      .catch((e: Error) => {
        console.error(`[sigma-daily] 실행 실패: ${e.message}`);
        process.exit(1);
      });
}
