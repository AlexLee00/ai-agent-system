#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildCollectAgentPlan,
  buildPerSymbolCollectBatches,
} from '../shared/pipeline-agent-plan.ts';

const cryptoDefault = buildCollectAgentPlan({ market: 'binance' });
assert.equal(cryptoDefault.source, 'default_market_plan');
assert.deepEqual(cryptoDefault.nodeIds, ['L06', 'L02', 'L03', 'L05']);
assert.deepEqual(cryptoDefault.perSymbolBatches, [['L02', 'L03', 'L05']]);
assert.equal(cryptoDefault.concurrencyLimit, 6);

const domesticDefault = buildCollectAgentPlan({ market: 'kis' });
assert.equal(domesticDefault.source, 'default_market_plan');
assert.deepEqual(domesticDefault.nodeIds, ['L06', 'L02', 'L03', 'L04']);
assert.deepEqual(domesticDefault.perSymbolBatches, [['L02', 'L03'], ['L04']]);
assert.equal(domesticDefault.portfolioNodeId, 'L06');

const agentTrimmed = buildCollectAgentPlan({
  market: 'kis',
  meta: {
    agentPlan: {
      collectNodeIds: ['L06', 'L02'],
      collectConcurrencyLimit: 2,
    },
  },
});
assert.equal(agentTrimmed.source, 'runtime_agent_plan');
assert.equal(agentTrimmed.overrideRequested, true);
assert.deepEqual(agentTrimmed.nodeIds, ['L06', 'L02']);
assert.deepEqual(agentTrimmed.perSymbolBatches, [['L02']]);
assert.equal(agentTrimmed.concurrencyLimit, 2);

const unsupported = buildCollectAgentPlan({
  market: 'binance',
  meta: { agent_plan: { collect_node_ids: ['L06', 'L04', 'L05'] } },
});
assert.equal(unsupported.source, 'runtime_agent_plan');
assert.deepEqual(unsupported.nodeIds, ['L06', 'L05']);
assert.equal(unsupported.warnings.includes('unsupported_collect_nodes:L04'), true);

const stringOverride = buildCollectAgentPlan({
  market: 'kis_overseas',
  meta: { collect_node_ids: 'L02, L03 L04' },
});
assert.equal(stringOverride.source, 'runtime_agent_plan');
assert.deepEqual(stringOverride.nodeIds, ['L02', 'L03', 'L04']);
assert.equal(stringOverride.portfolioNodeId, null);
assert.deepEqual(stringOverride.perSymbolBatches, [['L02', 'L03'], ['L04']]);

const invalidOverride = buildCollectAgentPlan({
  market: 'kis',
  meta: { collectNodeIds: ['L05'], collect_concurrency_limit: 99 },
});
assert.equal(invalidOverride.source, 'default_market_plan');
assert.deepEqual(invalidOverride.nodeIds, ['L06', 'L02', 'L03', 'L04']);
assert.equal(invalidOverride.warnings.includes('unsupported_collect_nodes:L05'), true);
assert.equal(invalidOverride.warnings.includes('agent_plan_empty_after_validation'), true);
assert.equal(invalidOverride.warnings.includes('collect_concurrency_limit_clamped'), true);
assert.equal(invalidOverride.concurrencyLimit, 8);

assert.deepEqual(
  buildPerSymbolCollectBatches('kis', ['L02', 'L03', 'L04']),
  [['L02', 'L03'], ['L04']],
);
assert.deepEqual(
  buildPerSymbolCollectBatches('binance', ['L02', 'L03', 'L05']),
  [['L02', 'L03', 'L05']],
);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ ok: true, checked: 7 }, null, 2));
} else {
  console.log('pipeline agent plan smoke ok');
}
