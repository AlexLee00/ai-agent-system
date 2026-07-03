#!/usr/bin/env node
// @ts-nocheck

const assert = require('node:assert/strict');
const {
  buildHubSelectorDiffReport,
  hubPolicyViaHubEnabled,
  normalizeChain,
} = require('../lib/jay-model-policy');

async function main() {
  assert.equal(hubPolicyViaHubEnabled({}), false);
  assert.equal(hubPolicyViaHubEnabled({ ORCH_LLM_POLICY_VIA_HUB: 'true' }), true);

  const off = await buildHubSelectorDiffReport({ enabled: false });
  assert.equal(off.enabled, false);
  assert.equal(off.mode, 'off_local_only');
  assert.equal(off.diffs.length, 2);
  assert.equal(off.diffs[0].skipped, true);

  const on = await buildHubSelectorDiffReport({
    enabled: true,
    fetchHubLlmSelector: async (request) => ({
      ok: true,
      chain: request.selectorKey === 'orchestrator.jay.intent'
        ? normalizeChain([
            { provider: 'openai-oauth', model: 'gpt-5.4' },
            { provider: 'openai-oauth', model: 'gpt-5.4-mini' },
          ])
        : normalizeChain([
            { provider: 'openai-oauth', model: 'gpt-5.4-mini' },
          ]),
    }),
  });
  assert.equal(on.enabled, true);
  assert.equal(on.mode, 'hub_dual_read');
  assert.equal(on.diffs.length, 2);
  assert.equal(on.diffs.every((diff) => typeof diff.match === 'boolean'), true);
  assert.equal(on.diffs.every((diff) => Array.isArray(diff.localChain) && Array.isArray(diff.hubChain)), true);

  console.log(JSON.stringify({ ok: true, smoke: 'orch-llm-policy-via-hub', checks: 8 }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
