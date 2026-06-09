#!/usr/bin/env tsx

const assert = require('node:assert/strict');
const { callGroqFallback, _testOnly } = require('../lib/llm/groq-fallback.ts');
const {
  getGroqAccountPoolStatus,
  resetGroqKeyBlacklistForTests,
  _testOnly: secretsTestOnly,
  _testOnlySetGroqAccounts,
  _testOnlyResetGroqAccounts,
} = require('../lib/llm/secrets-loader.ts');

const ORIGINAL_FETCH = global.fetch;
const ORIGINAL_GROQ_API_KEY = process.env.GROQ_API_KEY;
const ORIGINAL_GROQ_SERVICE_TIER = process.env.HUB_GROQ_SERVICE_TIER;
const ORIGINAL_GROQ_MAX_KEY_ATTEMPTS = process.env.HUB_GROQ_MAX_KEY_ATTEMPTS;
const ORIGINAL_GROQ_ACCOUNT_POOL_ENABLED = process.env.HUB_GROQ_ACCOUNT_POOL_ENABLED;

function readAuthHeader(headers: HeadersInit | undefined): string {
  if (!headers) return '';
  if (headers instanceof Headers) return String(headers.get('authorization') || '');
  if (Array.isArray(headers)) {
    return String(headers.find(([key]) => String(key).toLowerCase() === 'authorization')?.[1] || '');
  }
  return String((headers as Record<string, string>).Authorization || (headers as Record<string, string>).authorization || '');
}

async function main() {
  resetGroqKeyBlacklistForTests();
  process.env.GROQ_API_KEY = 'groq-smoke-key';
  delete process.env.HUB_GROQ_MAX_KEY_ATTEMPTS;
  delete process.env.HUB_GROQ_ACCOUNT_POOL_ENABLED;

  assert.equal(_testOnly.parseDurationMs('1m51.455s'), 111455);
  process.env.HUB_GROQ_SERVICE_TIER = 'flex';
  const payload = _testOnly.buildGroqRequestBody({
    prompt: 'payload check',
    model: 'openai/gpt-oss-20b',
    jsonSchema: {
      type: 'object',
      properties: { signal: { type: 'string' } },
      required: ['signal'],
      additionalProperties: false,
    },
    strictJsonSchema: true,
    temperature: 0,
  }, 'openai/gpt-oss-20b');
  assert.equal(payload.max_completion_tokens, 1024);
  assert.equal(payload.temperature, 1e-8);
  assert.equal(payload.reasoning_effort, 'low');
  assert.equal(payload.service_tier, 'flex');
  assert.equal(payload.response_format.type, 'json_schema');
  assert.equal(payload.response_format.json_schema.strict, true);

  const qwenPayload = _testOnly.buildGroqRequestBody({
    prompt: 'qwen reasoning check',
    model: 'qwen/qwen3-32b',
    temperature: 0,
  }, 'qwen/qwen3-32b');
  assert.equal(qwenPayload.reasoning_effort, 'none');
  assert.equal(qwenPayload.reasoning_format, undefined);
  assert.equal(qwenPayload.include_reasoning, undefined);

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

  resetGroqKeyBlacklistForTests();
  delete process.env.GROQ_API_KEY;
  delete process.env.HUB_GROQ_SERVICE_TIER;
  _testOnlySetGroqAccounts(['groq-smoke-1', 'groq-smoke-2', 'groq-smoke-3', 'groq-smoke-4', 'groq-smoke-5']);
  assert.equal(secretsTestOnly.groqAccountPoolEnabled(), true, 'Groq account pool should default to round-robin when multiple keys are configured');
  assert.deepEqual(getGroqAccountPoolStatus(), { total: 5, available: 5, cooldown: 0 });

  fetchCalls = 0;
  process.env.HUB_GROQ_ACCOUNT_POOL_ENABLED = 'false';
  global.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify({ error: { message: 'Rate limit reached. Please try again in 1s.' } }), {
      status: 429,
      headers: { 'retry-after': '1' },
    });
  };
  const singleKey = await callGroqFallback({ prompt: 'single primary key retry-after', model: 'llama-3.1-8b-instant' });
  assert.equal(singleKey.ok, false);
  assert.match(String(singleKey.error), /Groq 429/);
  assert.equal(fetchCalls, 1, 'Groq account pool kill switch should prevent multi-key rotation');

  resetGroqKeyBlacklistForTests();
  delete process.env.HUB_GROQ_ACCOUNT_POOL_ENABLED;
  assert.equal(secretsTestOnly.groqAccountPoolEnabled(), true);
  assert.deepEqual(getGroqAccountPoolStatus(), { total: 5, available: 5, cooldown: 0 });

  fetchCalls = 0;
  global.fetch = async (_url, init) => {
    fetchCalls += 1;
    const auth = readAuthHeader(init?.headers);
    assert.match(auth, /groq-smoke-/);
    if (fetchCalls < 5) {
      return new Response(JSON.stringify({ error: { message: 'Rate limit reached. Please try again in 1s.' } }), {
        status: 429,
        headers: { 'retry-after': '1' },
      });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }), {
      status: 200,
      headers: { 'x-ratelimit-remaining-requests': '999' },
    });
  };

  const pooled = await callGroqFallback({ prompt: 'pooled retry', model: 'llama-3.1-8b-instant' });
  assert.equal(pooled.ok, true);
  assert.equal(pooled.result, 'ok');
  assert.equal(fetchCalls, 5, 'Groq fallback must exhaust the configured key pool before failing');
  assert.equal(pooled.rateLimit['x-ratelimit-remaining-requests'], '999');
  assert.deepEqual(getGroqAccountPoolStatus(), { total: 5, available: 1, cooldown: 4 });

  const { _testOnly: unifiedTestOnly } = require('../lib/llm/unified-caller.ts');
  assert.equal(
    unifiedTestOnly._normalizeRoute('groq/llama-4-scout-17b-16e-instruct'),
    'groq/meta-llama/llama-4-scout-17b-16e-instruct',
  );
  assert.equal(
    unifiedTestOnly._normalizeRoute('groq/meta-llama/llama-4-scout-17b-16e-instruct'),
    'groq/meta-llama/llama-4-scout-17b-16e-instruct',
  );

  console.log(JSON.stringify({ ok: true, retry_after_ms: first.retryAfterMs, pooled_fetch_calls: fetchCalls }));
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
    if (ORIGINAL_GROQ_SERVICE_TIER === undefined) delete process.env.HUB_GROQ_SERVICE_TIER;
    else process.env.HUB_GROQ_SERVICE_TIER = ORIGINAL_GROQ_SERVICE_TIER;
    if (ORIGINAL_GROQ_MAX_KEY_ATTEMPTS === undefined) delete process.env.HUB_GROQ_MAX_KEY_ATTEMPTS;
    else process.env.HUB_GROQ_MAX_KEY_ATTEMPTS = ORIGINAL_GROQ_MAX_KEY_ATTEMPTS;
    if (ORIGINAL_GROQ_ACCOUNT_POOL_ENABLED === undefined) delete process.env.HUB_GROQ_ACCOUNT_POOL_ENABLED;
    else process.env.HUB_GROQ_ACCOUNT_POOL_ENABLED = ORIGINAL_GROQ_ACCOUNT_POOL_ENABLED;
    _testOnlyResetGroqAccounts();
    resetGroqKeyBlacklistForTests();
  });
