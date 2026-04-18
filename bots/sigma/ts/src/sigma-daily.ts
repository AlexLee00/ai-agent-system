/**
 * Sigma Daily — v2 Thin Adapter (Phase 5)
 *
 * v1 로직은 docs/archive/sigma-legacy/ 로 이관됨.
 * Elixir v2 Commander를 HTTP로 호출하는 adapter.
 */

const SIGMA_HTTP_PORT = process.env.SIGMA_HTTP_PORT || '4010';
const SIGMA_V2_ENDPOINT =
  process.env.SIGMA_V2_ENDPOINT || `http://127.0.0.1:${SIGMA_HTTP_PORT}/sigma/v2`;

export async function runDaily(options: { test?: boolean } = {}): Promise<any> {
  const response = await fetch(`${SIGMA_V2_ENDPOINT}/run-daily`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ test: options.test || false }),
    signal: AbortSignal.timeout(120_000),
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data;
}

export async function checkHealth(): Promise<any> {
  const response = await fetch(`${SIGMA_V2_ENDPOINT}/health`, {
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || `HTTP ${response.status}`);
  }
  return data;
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
