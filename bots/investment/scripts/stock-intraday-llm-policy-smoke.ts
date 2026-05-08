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
  CRYPTO_INTRADAY_LIGHT_COLLECT_NODES,
  STOCK_INTRADAY_LIGHT_COLLECT_NODES,
  buildStockResearchLlmPolicyMeta,
  buildStockIntradayLlmPolicyMeta,
  shouldRunStockIntradayDecisionLlm,
} from '../shared/stock-intraday-llm-policy.ts';

const disabledEnv = {
  LUNA_STOCK_INTRADAY_ENRICHMENT_ENABLED: 'false',
  LUNA_STOCK_INTRADAY_DEBATE_ENABLED: 'false',
  LUNA_CONSERVATIVE_RELAXATION_ENABLED: 'false',
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

const researchLightMeta = buildStockResearchLlmPolicyMeta({
  market: 'kis_overseas',
  marketScript: 'overseas',
  env: disabledEnv,
});
const researchLightCollect = buildCollectAgentPlan({ market: 'kis_overseas', meta: researchLightMeta });
assert.deepEqual(researchLightCollect.nodeIds, STOCK_INTRADAY_LIGHT_COLLECT_NODES);
assert.equal(researchLightCollect.nodeIds.includes('L03'), false, 'off-hours research must not run Sentinel/Hermes/Sophia by default');
assert.equal(researchLightMeta.research_only, true);
assert.equal(researchLightMeta.collect_mode, 'off_hours_research_light');

const researchFullMeta = buildStockResearchLlmPolicyMeta({
  market: 'kis_overseas',
  marketScript: 'overseas',
  env: enabledEnv,
});
const researchFullCollect = buildCollectAgentPlan({ market: 'kis_overseas', meta: researchFullMeta });
assert.equal(researchFullCollect.nodeIds.includes('L03'), true, 'explicit env should restore off-hours research enrichment');
assert.equal(researchFullMeta.collect_mode, 'off_hours_research_full');

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

const compositeBuyPrefilter = shouldRunStockIntradayDecisionLlm({
  market: 'kis',
  symbol: '005380',
  meta: lightMeta,
  analyses: [
    { analyst: 'ta_mtf', signal: 'BUY', confidence: 0.4 },
    { analyst: 'market_flow', signal: 'BUY', confidence: 0.43 },
  ],
  env: disabledEnv,
});
assert.equal(compositeBuyPrefilter.run, true, 'stock TA+flow BUY should pass intraday prefilter even when each signal is below 0.55');
assert.equal(compositeBuyPrefilter.reason, 'actionable_presignal');
assert.equal(compositeBuyPrefilter.support.role, 'flow');

const mtfDailyBuyPrefilter = shouldRunStockIntradayDecisionLlm({
  market: 'kis_overseas',
  symbol: 'ABEV',
  meta: lightMeta,
  analyses: [
    {
      analyst: 'ta_mtf',
      signal: 'HOLD',
      confidence: 0.2,
      reasoning: '미국주식 MTF: [일봉 60%] BUY (40%) | [1시간봉 40%] HOLD (10%) → 가중점수 1.00',
    },
    {
      analyst: 'market_flow',
      signal: 'HOLD',
      confidence: 0.12,
      reasoning: 'TA HOLD 20% | SEC 공시 증가',
    },
  ],
  env: disabledEnv,
});
assert.equal(mtfDailyBuyPrefilter.run, true, 'daily BUY + strong MTF score should reach L13 instead of being dropped before decision');
assert.equal(mtfDailyBuyPrefilter.reason, 'stock_actionable_technical_presignal');
assert.equal(mtfDailyBuyPrefilter.technical.mtfEvidence.dailyBuyFrames, 1);

const cryptoMeta = buildStockIntradayLlmPolicyMeta({
  market: 'binance',
  marketScript: 'crypto',
  env: disabledEnv,
});
const cryptoCollect = buildCollectAgentPlan({ market: 'binance', meta: cryptoMeta });
assert.deepEqual(cryptoCollect.nodeIds, CRYPTO_INTRADAY_LIGHT_COLLECT_NODES, 'crypto intraday cycle must use technical-first light collect by default');
assert.equal(cryptoCollect.nodeIds.includes('L03'), false, 'crypto intraday cycle must not run Sentinel/Hermes/Sophia by default');
assert.equal(cryptoCollect.nodeIds.includes('L05'), false, 'crypto intraday cycle must not run Oracle LLM by default');
assert.equal(cryptoMeta.collect_mode, 'intraday_monitoring_light');
assert.equal(cryptoMeta.llm_call_policy.source_enrichment, 'technical_first_only');

const cryptoFullMeta = buildStockIntradayLlmPolicyMeta({
  market: 'binance',
  marketScript: 'crypto',
  env: { LUNA_CRYPTO_INTRADAY_ENRICHMENT_ENABLED: 'true' },
});
const cryptoFullCollect = buildCollectAgentPlan({ market: 'binance', meta: cryptoFullMeta });
assert.deepEqual(cryptoFullCollect.nodeIds, ['L06', 'L02', 'L03', 'L05']);

const cryptoNarrativeOnly = shouldRunStockIntradayDecisionLlm({
  market: 'binance',
  symbol: 'NIL/USDT',
  analyses: [
    { analyst: 'sentiment', signal: 'BUY', confidence: 0.9 },
    { analyst: 'news', signal: 'BUY', confidence: 0.9 },
    { analyst: 'ta_mtf', signal: 'HOLD', confidence: 0.8 },
  ],
  env: disabledEnv,
});
assert.equal(cryptoNarrativeOnly.run, false);
assert.equal(cryptoNarrativeOnly.reason, 'crypto_intraday_no_technical_presignal');

const cryptoMtfTechnicalFirst = shouldRunStockIntradayDecisionLlm({
  market: 'binance',
  symbol: 'CHIP/USDT',
  meta: cryptoMeta,
  analyses: [
    {
      analyst: 'ta_mtf',
      signal: 'HOLD',
      confidence: 0.1,
      reasoning: '15m BUY | weightedScore 0.50 | trendBoost 0.1',
    },
  ],
  env: disabledEnv,
});
assert.equal(cryptoMtfTechnicalFirst.run, true);
assert.equal(cryptoMtfTechnicalFirst.reason, 'crypto_actionable_technical_presignal');
assert.equal(cryptoMtfTechnicalFirst.technical.mtfEvidence.intradayBuyFrames, 1);

const cryptoMtfSellConflict = shouldRunStockIntradayDecisionLlm({
  market: 'binance',
  symbol: 'NOT/USDT',
  meta: cryptoMeta,
  analyses: [
    {
      analyst: 'ta_mtf',
      signal: 'HOLD',
      confidence: 0.1,
      reasoning: '15m BUY | daily SELL | weightedScore 0.70',
    },
  ],
  env: disabledEnv,
});
assert.equal(cryptoMtfSellConflict.run, false);
assert.equal(cryptoMtfSellConflict.reason, 'crypto_intraday_technical_conflict');
assert.equal(cryptoMtfSellConflict.mtfEvidence.dailySellFrames, 1);

const cryptoMtfWeak = shouldRunStockIntradayDecisionLlm({
  market: 'binance',
  symbol: 'DYDX/USDT',
  meta: cryptoMeta,
  analyses: [
    {
      analyst: 'ta_mtf',
      signal: 'HOLD',
      confidence: 0.1,
      reasoning: '4h BUY | daily BUY | weightedScore 0.20',
    },
  ],
  env: disabledEnv,
});
assert.equal(cryptoMtfWeak.run, false);
assert.equal(cryptoMtfWeak.reason, 'crypto_intraday_technical_presignal_weak');

const cryptoMtfFullRequiresFlow = shouldRunStockIntradayDecisionLlm({
  market: 'binance',
  symbol: 'CHIP/USDT',
  meta: cryptoFullMeta,
  analyses: [
    {
      analyst: 'ta_mtf',
      signal: 'HOLD',
      confidence: 0.1,
      reasoning: '15m BUY | weightedScore 0.50',
    },
  ],
  env: { ...disabledEnv, LUNA_CRYPTO_INTRADAY_ENRICHMENT_ENABLED: 'true' },
});
assert.equal(cryptoMtfFullRequiresFlow.run, false);
assert.equal(cryptoMtfFullRequiresFlow.reason, 'crypto_intraday_no_flow_presignal');

const cryptoTechnicalOnly = shouldRunStockIntradayDecisionLlm({
  market: 'binance',
  symbol: 'NIL/USDT',
  meta: cryptoMeta,
  analyses: [
    { analyst: 'ta_mtf', signal: 'BUY', confidence: 0.33 },
    { analyst: 'onchain', signal: 'HOLD', confidence: 0.8 },
  ],
  env: disabledEnv,
});
assert.equal(cryptoTechnicalOnly.run, true);
assert.equal(cryptoTechnicalOnly.reason, 'crypto_actionable_technical_presignal');

const cryptoTaFlow = shouldRunStockIntradayDecisionLlm({
  market: 'binance',
  symbol: 'NIL/USDT',
  meta: cryptoFullMeta,
  analyses: [
    { analyst: 'ta_mtf', signal: 'BUY', confidence: 0.33 },
    { analyst: 'onchain', signal: 'BUY', confidence: 0.61 },
  ],
  env: { ...disabledEnv, LUNA_CRYPTO_INTRADAY_ENRICHMENT_ENABLED: 'true' },
});
assert.equal(cryptoTaFlow.run, true);
assert.equal(cryptoTaFlow.reason, 'crypto_actionable_ta_flow_presignal');

const relaxEnv = {
  ...disabledEnv,
  LUNA_CONSERVATIVE_RELAXATION_ENABLED: 'true',
};

const stockRelaxedNarrative = shouldRunStockIntradayDecisionLlm({
  market: 'kis_overseas',
  symbol: 'NVDA',
  analyses: [
    { analyst: 'news', signal: 'BUY', confidence: 0.54 },
    { analyst: 'ta_mtf', signal: 'HOLD', confidence: 0.56 },
    { analyst: 'market_flow', signal: 'HOLD', confidence: 0.55 },
    { analyst: 'sentiment', signal: 'HOLD', confidence: 0.53 },
  ],
  env: relaxEnv,
});
assert.equal(stockRelaxedNarrative.run, true);
assert.equal(stockRelaxedNarrative.reason, 'stock_relaxed_narrative_probe');
assert.equal(stockRelaxedNarrative.relaxation.ok, true);

const cryptoRelaxedNarrative = shouldRunStockIntradayDecisionLlm({
  market: 'binance',
  symbol: 'NIL/USDT',
  analyses: [
    { analyst: 'sentiment', signal: 'BUY', confidence: 0.86 },
    { analyst: 'news', signal: 'BUY', confidence: 0.84 },
    { analyst: 'ta_mtf', signal: 'HOLD', confidence: 0.7 },
    { analyst: 'onchain', signal: 'HOLD', confidence: 0.7 },
  ],
  env: relaxEnv,
});
assert.equal(cryptoRelaxedNarrative.run, true);
assert.equal(cryptoRelaxedNarrative.reason, 'crypto_relaxed_narrative_probe');
assert.equal(cryptoRelaxedNarrative.relaxation.ok, true);

const cryptoRelaxedMtfMomentum = shouldRunStockIntradayDecisionLlm({
  market: 'binance',
  symbol: 'NOT/USDT',
  analyses: [
    {
      analyst: 'ta_mtf',
      signal: 'BUY',
      confidence: 0.19,
      reasoning: '15분봉=BUY(40%) | 1시간봉=BUY(40%) | 4시간봉=HOLD(10%) | 일봉=SELL(10%); 가중점수 0.95; 추세보정 +0.28',
    },
    { analyst: 'onchain', signal: 'HOLD', confidence: 0.49 },
    { analyst: 'sentiment', signal: 'HOLD', confidence: 0.45 },
    { analyst: 'news', signal: 'HOLD', confidence: 0.35 },
  ],
  env: relaxEnv,
});
assert.equal(cryptoRelaxedMtfMomentum.run, true);
assert.equal(cryptoRelaxedMtfMomentum.reason, 'crypto_relaxed_mtf_momentum_probe');
assert.equal(cryptoRelaxedMtfMomentum.relaxation.momentumEvidence.intradayBuyFrames, 2);
assert.equal(cryptoRelaxedMtfMomentum.relaxation.sizeRatio, 0.25);

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
  finishRun: async () => ({ updated: true, reason: 'fixture' }),
});

assert.equal(refresh.ok, true);
const refreshCollect = buildCollectAgentPlan({ market: 'kis', meta: capturedRefreshMeta });
assert.deepEqual(refreshCollect.nodeIds, STOCK_INTRADAY_LIGHT_COLLECT_NODES, 'stock active-candidate refresh should use light collect by default');

capturedRefreshMeta = null;
const cryptoRefresh = await runActiveCandidateAnalysisRefresh({
  market: 'crypto',
  apply: true,
  confirm: 'luna-active-candidate-analysis-refresh',
  statePath: path.join(tmpDir, 'crypto-state.json'),
  reportBuilder: async () => ({
    status: 'fixture',
    missingActiveCandidateSymbols: ['NIL/USDT'],
  }),
  collectRunner: async (input) => {
    capturedRefreshMeta = input.meta;
    return {
      ok: true,
      sessionId: 'fixture-crypto-session',
      symbols: input.symbols,
      summaries: [],
      metrics: { failedHardCoreTasks: 0 },
    };
  },
  finishRun: async () => ({ updated: true, reason: 'fixture' }),
});

assert.equal(cryptoRefresh.ok, true);
const cryptoRefreshCollect = buildCollectAgentPlan({ market: 'binance', meta: capturedRefreshMeta });
assert.deepEqual(cryptoRefreshCollect.nodeIds, CRYPTO_INTRADAY_LIGHT_COLLECT_NODES, 'crypto active-candidate refresh should use technical-first collect by default');

console.log(JSON.stringify({
  ok: true,
  lightCollectNodes: lightCollect.nodeIds,
  lightDebateEnabled: lightDecision.debateEnabled,
  fullCollectNodes: fullCollect.nodeIds,
  fullDebateEnabled: fullDecision.debateEnabled,
  researchLightCollectNodes: researchLightCollect.nodeIds,
  researchFullCollectNodes: researchFullCollect.nodeIds,
  holdPrefilter,
  buyPrefilter,
  cryptoCollectNodes: cryptoCollect.nodeIds,
  cryptoFullCollectNodes: cryptoFullCollect.nodeIds,
  cryptoNarrativeOnly,
  cryptoTechnicalOnly,
  cryptoTaFlow,
  stockRelaxedNarrative,
  cryptoRelaxedNarrative,
  cryptoRelaxedMtfMomentum,
  refreshCollectNodes: refreshCollect.nodeIds,
  cryptoRefreshCollectNodes: cryptoRefreshCollect.nodeIds,
}, null, 2));
