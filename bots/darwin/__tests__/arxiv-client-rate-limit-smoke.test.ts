'use strict';

const assert = require('assert');
const path = require('path');

const arxivPath = path.join(__dirname, '../lib/arxiv-client.ts');

interface MockHeaders {
  get(name: string): string | null;
}

interface MockResponse {
  ok: boolean;
  status: number;
  headers: MockHeaders;
  text(): Promise<string>;
}

interface ArxivClientTestApi {
  _testOnly_buildQuery(keyword: string): string;
  _testOnly_fetchWithRetry(url: string, context: string): Promise<MockResponse>;
  _testOnly_resetRequestThrottle(): void;
  _testOnly_retryDelayMs(res: { headers: MockHeaders } | null, status: number | undefined, attempt: number): number;
}

const envKeys = [
  'DARWIN_ARXIV_GLOBAL_REQUEST_GAP_MS',
  'DARWIN_ARXIV_MAX_RETRIES',
  'DARWIN_ARXIV_RATE_LIMIT_RETRY_DELAY_MS',
  'DARWIN_ARXIV_RETRY_BASE_DELAY_MS',
  'DARWIN_ARXIV_REQUEST_TIMEOUT_MS',
];

function mockHeaders(retryAfter = ''): MockHeaders {
  return {
    get(name: string) {
      return name.toLowerCase() === 'retry-after' && retryAfter ? retryAfter : null;
    },
  };
}

function mockResponse(ok: boolean, status: number, retryAfter = ''): MockResponse {
  return {
    ok,
    status,
    headers: mockHeaders(retryAfter),
    text: async () => '',
  };
}

async function main() {
  const originalFetch = (globalThis as unknown as { fetch?: unknown }).fetch;
  const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));

  process.env.DARWIN_ARXIV_GLOBAL_REQUEST_GAP_MS = '500';
  process.env.DARWIN_ARXIV_MAX_RETRIES = '1';
  process.env.DARWIN_ARXIV_RATE_LIMIT_RETRY_DELAY_MS = '500';
  process.env.DARWIN_ARXIV_RETRY_BASE_DELAY_MS = '500';
  process.env.DARWIN_ARXIV_REQUEST_TIMEOUT_MS = '5000';

  try {
    delete require.cache[arxivPath];
    const client = require(arxivPath) as ArxivClientTestApi;

    assert.strictEqual(
      client._testOnly_buildQuery('multi agent system'),
      'all:multi+AND+all:agent+AND+all:system',
    );
    assert.strictEqual(
      client._testOnly_retryDelayMs({ headers: mockHeaders('2') }, 429, 0),
      2000,
    );
    assert.strictEqual(
      client._testOnly_retryDelayMs({ headers: mockHeaders() }, 429, 0),
      500,
    );

    let fetchCalls = 0;
    (globalThis as unknown as { fetch: unknown }).fetch = async () => {
      fetchCalls += 1;
      return fetchCalls === 1
        ? mockResponse(false, 429)
        : mockResponse(true, 200);
    };

    client._testOnly_resetRequestThrottle();
    const retried = await client._testOnly_fetchWithRetry('http://example.test/arxiv', 'rate-limit-smoke');

    assert.strictEqual(retried.ok, true);
    assert.strictEqual(fetchCalls, 2);

    console.log('✅ darwin arxiv rate-limit smoke ok');
  } finally {
    if (originalFetch === undefined) {
      delete (globalThis as unknown as { fetch?: unknown }).fetch;
    } else {
      (globalThis as unknown as { fetch: unknown }).fetch = originalFetch;
    }

    for (const [key, value] of originalEnv.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    delete require.cache[arxivPath];
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
