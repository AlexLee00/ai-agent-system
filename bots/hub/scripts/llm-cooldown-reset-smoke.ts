#!/usr/bin/env tsx

import assert from 'node:assert/strict';

const {
  _testOnlySetProviderCooldown,
  _testOnlySetProviderCooldownAt,
  getProviderCooldownSnapshot,
  pruneProviderCooldowns,
  resetProviderCooldown,
} = require('../../../packages/core/lib/llm-fallback');
const { llmCircuitRoute } = require('../lib/routes/llm.ts');
const { recordFailure } = require('../lib/llm/provider-registry.ts');

function fakeRes() {
  const result: any = { statusCode: 200, body: null };
  return {
    status(code: number) {
      result.statusCode = code;
      return this;
    },
    json(body: unknown) {
      result.body = body;
      return result;
    },
    result,
  };
}

async function invoke(method: string, query: Record<string, string> = {}) {
  const res = fakeRes();
  await llmCircuitRoute({ method, query }, res);
  return res.result;
}

async function main() {
  resetProviderCooldown();
  _testOnlySetProviderCooldown('openai-oauth');
  let snapshot = getProviderCooldownSnapshot();
  assert.equal(snapshot['openai-oauth'].cooling_down, true);

  _testOnlySetProviderCooldownAt('expired-provider', 4, Date.now() - 120_000);
  const pruned = pruneProviderCooldowns();
  assert.ok(pruned.pruned.includes('expired-provider'));
  assert.equal(getProviderCooldownSnapshot()['expired-provider'], undefined);

  const getResult = await invoke('GET');
  assert.equal(getResult.statusCode, 200);
  assert.equal(getResult.body.provider_cooldowns['openai-oauth'].cooling_down, true);
  assert.equal(getResult.body.any_open, true);

  const resetOne = await invoke('DELETE', { provider: 'openai-oauth' });
  assert.equal(resetOne.statusCode, 200);
  assert.deepEqual(resetOne.body.reset_cooldowns, ['openai-oauth']);
  snapshot = getProviderCooldownSnapshot();
  assert.equal(snapshot['openai-oauth'], undefined);

  _testOnlySetProviderCooldown('groq');
  _testOnlySetProviderCooldown('gemini-oauth');
  recordFailure('openai-oauth', 'smoke_provider_stat', 12);
  const resetAll = await invoke('DELETE');
  assert.equal(resetAll.statusCode, 200);
  assert.equal(resetAll.body.reset, 'all');
  assert.ok(resetAll.body.reset_provider_circuits.includes('openai-oauth'));
  assert.deepEqual(resetAll.body.reset_cooldowns.sort(), ['gemini-oauth', 'groq']);
  assert.deepEqual(getProviderCooldownSnapshot(), {});

  console.log(JSON.stringify({
    ok: true,
    provider_reset: true,
    all_reset: true,
    route_contract: true,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
