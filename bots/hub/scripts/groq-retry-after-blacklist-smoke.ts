#!/usr/bin/env tsx

const assert = require('node:assert/strict');
const { callGroqFallback, _testOnly } = require('../lib/llm/groq-fallback.ts');
const { resetGroqKeyBlacklistForTests } = require('../lib/llm/secrets-loader.ts');

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_GROQ_API_KEY = process.env.GROQ_API_KEY;

async function main() {
  resetGroqKeyBlacklistForTests();
  process.env.GROQ_API_KEY = 'groq-smoke-key';

  assert.equal(_testOnly.parseDurationMs('1m51.455s'), 111455);

  let fetchCalls = 0;
  global.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({
      error: {
        message: 'Rate limit reached. Please try again in 2m0s.',
      },
    }), {
      status: 429,
      headers: {
        'retry-after': '120',
      },
    });
  };

  const first = await callGroqFallback({ prompt: 'rate limited', model: 'llama-3.1-8b-instant' });
  const second = await callGroqFallback({ prompt: 'rate limited again', model: 'llama-3.1-8b-instant' });

  assert.equal(first.ok, false);
  assert.match(String(first.error), /Groq 429/);
  assert.ok(Number(first.retryAfterMs) >= 120_000, 'retry-after must be propagated from provider');
  assert.equal(second.ok, false);
  assert.match(String(second.error), /cooldown/);
  assert.equal(fetchCalls, 1, 'blacklisted Groq key must not be retried immediately');

  console.log(JSON.stringify({ ok: true, retry_after_ms: first.retryAfterMs, fetch_calls: fetchCalls }));
}

main()
  .catch((error) => {
    console.error('[groq-retry-after-blacklist-smoke] failed:', error?.stack || error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => {
    global.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_GROQ_API_KEY === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = ORIGINAL_GROQ_API_KEY;
    resetGroqKeyBlacklistForTests();
  });
