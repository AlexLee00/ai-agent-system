#!/usr/bin/env tsx

const assert = require('node:assert/strict');
const { _testOnly } = require('../lib/llm/unified-caller.ts');

async function main() {
  const req = {
    callerTeam: 'luna',
    agent: 'hermes',
    selectorKey: 'investment.hermes',
    abstractModel: 'anthropic_haiku',
    systemPrompt: 'dedupe smoke system',
    prompt: 'dedupe smoke prompt',
  };

  let calls = 0;
  const executor = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return {
      ok: true,
      provider: 'openai-oauth',
      result: 'ok',
      durationMs: 50,
      totalCostUsd: 0.01,
    };
  };

  const [first, second] = await Promise.all([
    _testOnly._runWithInflightDedupe(req, executor),
    _testOnly._runWithInflightDedupe(req, executor),
  ]);

  assert.equal(calls, 1, 'identical in-flight prompts must share one provider call');
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.dedupeHit, true);
  assert.equal(second.dedupeProvider, 'openai-oauth');
  assert.equal(second.totalCostUsd, 0);
  assert.equal(_testOnly._inflightDedupeSize(), 0, 'dedupe map must be released after completion');

  const differentOptionCalls = await Promise.all([
    _testOnly._runWithInflightDedupe({ ...req, maxTokens: 64 }, executor),
    _testOnly._runWithInflightDedupe({ ...req, maxTokens: 128 }, executor),
  ]);
  assert.equal(differentOptionCalls.some((resp) => resp.dedupeHit), false, 'different generation options must not dedupe');
  assert.equal(calls, 3, 'only exact in-flight request equivalents may share provider calls');

  console.log(JSON.stringify({ ok: true, calls, dedupe_hit: Boolean(second.dedupeHit) }));
}

main().catch((error) => {
  console.error('[llm-inflight-dedupe-smoke] failed:', error?.stack || error?.message || error);
  process.exitCode = 1;
});
