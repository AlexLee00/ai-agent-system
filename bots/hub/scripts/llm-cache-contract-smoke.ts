#!/usr/bin/env tsx

const assert = require('node:assert/strict');
const pgPool = require('../../../packages/core/lib/pg-pool');
const {
  checkCache,
  computeHash,
  saveCache,
} = require('../lib/llm/cache.ts');

const originalEnabled = process.env.HUB_LLM_CACHE_ENABLED;

async function main() {
  process.env.HUB_LLM_CACHE_ENABLED = 'true';

  const key = {
    abstractModel: 'anthropic_haiku',
    callerTeam: 'luna',
    agent: 'hermes',
    taskType: 'sentiment',
    selectorKey: 'investment.agent_policy',
    systemPrompt: 'cache smoke system',
    prompt: `cache smoke prompt ${Date.now()}`,
    maxTokens: 64,
    temperature: null,
  };
  const hash = computeHash(key);

  await pgPool.run('public', 'DELETE FROM llm_cache WHERE prompt_hash = $1', [hash]).catch(() => null);
  await saveCache(key, 'cached-response', { in: 3, out: 2 }, 0.001, 'sentiment_realtime');

  const hit = await checkCache(key);
  assert.equal(hit.hit, true, 'saved cache entry must be readable');
  assert.equal(hit.response, 'cached-response');

  const optionMismatch = await checkCache({ ...key, maxTokens: 128 });
  assert.equal(optionMismatch.hit, false, 'generation option mismatch must not hit cache');

  await pgPool.run('public', 'DELETE FROM llm_cache WHERE prompt_hash = $1', [hash]).catch(() => null);

  console.log(JSON.stringify({ ok: true, cache_hit: hit.hit, option_mismatch_hit: optionMismatch.hit }));
}

main()
  .catch((error) => {
    console.error('[llm-cache-contract-smoke] failed:', error?.stack || error?.message || error);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (originalEnabled === undefined) delete process.env.HUB_LLM_CACHE_ENABLED;
    else process.env.HUB_LLM_CACHE_ENABLED = originalEnabled;
    await pgPool.closeAll?.().catch?.(() => null);
  });
