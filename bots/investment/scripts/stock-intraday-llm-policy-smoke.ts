#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runActiveCandidateAnalysisRefresh } from './runtime-luna-active-candidate-analysis-refresh.ts';
import { buildCollectAgentPlan } from '../shared/pipeline-agent-plan.ts';
import { buildDecisionAgentPlan } from '../shared/pipeline-decision-agent-plan.ts';
import {
  STOCK_INTRADAY_LIGHT_COLLECT_NODES,
  buildStockIntradayLlmPolicyMeta,
  shouldRunStockIntradayDecisionLlm,
} from '../shared/stock-intraday-llm-policy.ts';

const disabledEnv = {
  LUNA_STOCK_INTRADAY_ENRICHMENT_ENABLED: 'false',
  LUNA_STOCK_INTRADAY_DEBATE_ENABLED: 'false',
};

const lightMeta = buildStockIntradayLlmPolicyMeta({
  market: 'kis_overseas',
  marketScript: 'overseas',
  env: disabledEnv,
});
const lightCollect = buildCollectAgentPlan({ market: 'kis_overseas', meta: lightMeta });
const lightDecision = buildDecisionAgentPlan({
  exchange: 'kis_overseas',
  meta: lightMeta,
  defaultDebateLimit: 2,
  runtimeFlags: { phases: {} },
});

assert.deepEqual(lightCollect.nodeIds, STOCK_INTRADAY_LIGHT_COLLECT_NODES);
assert.equal(lightCollect.nodeIds.includes('L03'), false, 'intraday stock cycle must not run Sentinel/Hermes/Sophia by default');
assert.equal(lightDecision.debateEnabled, false, 'intraday stock cycle must not run debate by default');
assert.equal(lightDecision.debateLimit, 0);
assert.equal(lightMeta.collect_mode, 'intraday_monitoring_light');
assert.equal(lightMeta.llm_call_policy.source_enrichment, 'pre_market_or_research_only');

const enabledEnv = {
  LUNA_STOCK_INTRADAY_ENRICHMENT_ENABLED: 'true',
  LUNA_STOCK_INTRADAY_DEBATE_ENABLED: 'true',
};
const fullMeta = buildStockIntradayLlmPolicyMeta({
  market: 'kis',
  marketScript: 'domestic',
  env: enabledEnv,
});
const fullCollect = buildCollectAgentPlan({ market: 'kis', meta: fullMeta });
const fullDecision = buildDecisionAgentPlan({
  exchange: 'kis',
  meta: fullMeta,
  defaultDebateLimit: 2,
  runtimeFlags: { phases: {} },
});

assert.equal(fullCollect.nodeIds.includes('L03'), true, 'explicit env should restore enrichment path');
assert.equal(fullDecision.debateEnabled, true, 'explicit env should restore debate path');
assert.equal(fullMeta.collect_mode, 'screening_with_maintenance');

const holdPrefilter = shouldRunStockIntradayDecisionLlm({
  market: 'kis',
  symbol: '005930',
  meta: lightMeta,
  analyses: [
    { analyst: 'ta_mtf', signal: 'HOLD', confidence: 0.8 },
    { analyst: 'market_flow', signal: 'BUY', confidence: 0.42 },
  ],
  env: disabledEnv,
});
assert.equal(holdPrefilter.run, false);
assert.equal(holdPrefilter.reason, 'stock_intraday_no_actionable_presignal');

const buyPrefilter = shouldRunStockIntradayDecisionLlm({
  market: 'kis',
  symbol: '005930',
  meta: lightMeta,
  analyses: [
    { analyst: 'ta_mtf', signal: 'BUY', confidence: 0.61 },
  ],
  env: disabledEnv,
});
assert.equal(buyPrefilter.run, true);
assert.equal(buyPrefilter.reason, 'actionable_presignal');

const cryptoMeta = buildStockIntradayLlmPolicyMeta({
  market: 'binance',
  marketScript: 'crypto',
  env: disabledEnv,
});
assert.equal(cryptoMeta.agentPlan, undefined, 'crypto path must not inherit stock intraday policy');

let capturedRefreshMeta = null;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-intraday-llm-policy-'));
const refresh = await runActiveCandidateAnalysisRefresh({
  market: 'domestic',
  apply: true,
  confirm: 'luna-active-candidate-analysis-refresh',
  statePath: path.join(tmpDir, 'state.json'),
  reportBuilder: async () => ({
    status: 'fixture',
    missingActiveCandidateSymbols: ['005930'],
  }),
  collectRunner: async (input) => {
    capturedRefreshMeta = input.meta;
    return {
      ok: true,
      sessionId: 'fixture-session',
      symbols: input.symbols,
      summaries: [],
      metrics: { failedHardCoreTasks: 0 },
    };
  },
});

assert.equal(refresh.ok, true);
const refreshCollect = buildCollectAgentPlan({ market: 'kis', meta: capturedRefreshMeta });
assert.deepEqual(refreshCollect.nodeIds, STOCK_INTRADAY_LIGHT_COLLECT_NODES, 'stock active-candidate refresh should use light collect by default');

console.log(JSON.stringify({
  ok: true,
  lightCollectNodes: lightCollect.nodeIds,
  lightDebateEnabled: lightDecision.debateEnabled,
  fullCollectNodes: fullCollect.nodeIds,
  fullDebateEnabled: fullDecision.debateEnabled,
  holdPrefilter,
  buyPrefilter,
  refreshCollectNodes: refreshCollect.nodeIds,
}, null, 2));
