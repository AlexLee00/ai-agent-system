#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { detectHMMRegime } from '../shared/hmm-regime-detector.ts';
import { forecastGarchVolatility } from '../shared/garch-volatility.ts';
import { analyzeFinbertSentiment } from '../shared/finbert-analyzer.ts';
import { calculateWorldQuantAlphas } from '../shared/worldquant-alphas.ts';
import { buildLunaAnalysisPredictionPhaseA } from '../shared/luna-analysis-prediction-phase-a.ts';
import { buildStrategyRoute, applyStrategyRouteDecisionBias } from '../shared/strategy-router.ts';
import {
  PHASE_A_SHADOW_LOG_CONFIRM,
  runLunaAnalysisPredictionPhaseA,
  runLunaAnalysisPredictionPhaseABatch,
  runLunaAnalysisPredictionPhaseAPromotionGate,
} from './runtime-luna-analysis-prediction-phase-a.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INVESTMENT_ROOT = resolve(__dirname, '..');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function sampleBars(direction = 'up') {
  return Array.from({ length: 90 }, (_, index) => {
    const drift = direction === 'down' ? -0.28 : 0.35;
    const base = 100 + index * drift + Math.sin(index / 4) * 1.1;
    return {
      open: base - 0.25,
      high: base + 1.4,
      low: base - 1.0,
      close: base + (index % 4) * 0.2,
      volume: 100000 + index * 2500 + (index % 5) * 7000,
    };
  });
}

export async function runLunaAnalysisPredictionPhaseASmoke() {
  const migration = resolve(INVESTMENT_ROOT, 'migrations/20260525000001_luna_analysis_prediction_phase_a_logs.sql');
  assert.equal(existsSync(migration), true);
  assert.match(readFileSync(migration, 'utf8'), /CREATE TABLE IF NOT EXISTS investment\.hmm_regime_log/u);

  const bars = sampleBars('up');
  const hmm = detectHMMRegime({ bars });
  assert.equal(hmm.ok, true);
  assert.ok(['bull', 'sideways', 'volatile'].includes(hmm.currentRegime));
  assert.equal(Object.keys(hmm.regimeProbabilities).length, 4);

  const garch = forecastGarchVolatility({ bars });
  assert.equal(garch.ok, true);
  assert.ok(garch.volatilityForecast.h24 > 0);
  assert.ok(garch.positionSizeFactor > 0 && garch.positionSizeFactor <= 1);

  const finbert = analyzeFinbertSentiment({
    events: [
      { symbol: '005930', text: '삼성전자 호실적 성장 자사주 매입 수주 증가' },
      { symbol: '005930', text: 'record profit beat and strong upgrade' },
    ],
  });
  assert.equal(finbert.ok, true);
  assert.equal(finbert.aggregate.sentiment, 'positive');

  const worldquant = calculateWorldQuantAlphas({ bars, factors: { quality: 0.7, hml: 0.6 } });
  assert.equal(worldquant.ok, true);
  assert.equal(worldquant.alphaCount, 20);

  const phaseA = buildLunaAnalysisPredictionPhaseA({
    symbol: '005930',
    market: 'domestic',
    bars,
    evidence: [{ symbol: '005930', text: '호실적 성장 자사주 매입' }],
    factors: { quality: 0.7, hml: 0.6 },
  });
  assert.equal(phaseA.ok, true);
  assert.equal(phaseA.shadowOnly, true);
  assert.ok(phaseA.predictiveScore > 0.45);

  const diagnosticRoute = await buildStrategyRoute({
    symbol: '005930',
    exchange: 'kis',
    phaseAEvidence: phaseA,
    marketRegime: { regime: phaseA.modules.hmm.currentRegime },
    decision: { action: 'BUY', confidence: phaseA.predictiveScore, amount_usdt: 50000, reasoning: 'phase a' },
  });
  assert.equal(diagnosticRoute.phaseA.influenceMode, 'diagnostic');
  assert.equal(diagnosticRoute.reasons.some((reason) => String(reason).includes('Phase A')), false);
  assert.equal(Object.hasOwn(diagnosticRoute, 'learnedBias'), false);

  let learnedProviderCalledInOffMode = false;
  const offRegressionRoute = await buildStrategyRoute({
    symbol: '005930',
    exchange: 'kis',
    phaseAEvidence: phaseA,
    marketRegime: { regime: phaseA.modules.hmm.currentRegime },
    env: { LUNA_LEARNED_BIAS_MODE: 'off' },
    learnedWeightsProvider: async () => {
      learnedProviderCalledInOffMode = true;
      throw new Error('learned provider should not be called in off mode');
    },
    decision: { action: 'BUY', confidence: phaseA.predictiveScore, amount_usdt: 50000, reasoning: 'phase a' },
  });
  assert.equal(learnedProviderCalledInOffMode, false);
  assert.deepEqual(offRegressionRoute.scores, diagnosticRoute.scores);
  assert.deepEqual(offRegressionRoute.ranking, diagnosticRoute.ranking);

  const learnedShadowRoute = await buildStrategyRoute({
    symbol: '005930',
    exchange: 'kis',
    phaseAEvidence: phaseA,
    marketRegime: { regime: phaseA.modules.hmm.currentRegime },
    env: { LUNA_LEARNED_BIAS_MODE: 'shadow' },
    learnedWeightsProvider: async () => [{
      regime: 'TRENDING_BULL',
      signalWeights: { momentum: 0.65, breakout: 0.20, mean_reversion: 0.05, defensive: 0.10 },
      totalTrades: 42,
    }],
    decision: { action: 'BUY', confidence: phaseA.predictiveScore, amount_usdt: 50000, reasoning: 'phase a' },
  });
  assert.deepEqual(learnedShadowRoute.scores, diagnosticRoute.scores);
  assert.equal(learnedShadowRoute.learnedBias.mode, 'shadow');

  const route = await buildStrategyRoute({
    symbol: '005930',
    exchange: 'kis',
    phaseAEvidence: phaseA,
    phaseAInfluence: 'shadow_bias',
    marketRegime: { regime: phaseA.modules.hmm.currentRegime },
    decision: { action: 'BUY', confidence: phaseA.predictiveScore, amount_usdt: 50000, reasoning: 'phase a' },
  });
  assert.equal(route.phaseA.shadowOnly, true);
  assert.equal(route.phaseA.predictiveScore, phaseA.predictiveScore);
  assert.equal(route.phaseA.influenceMode, 'shadow_bias');
  assert.equal(route.phaseA.influenceWeight, 0.25);

  const adjusted = applyStrategyRouteDecisionBias(
    { action: 'BUY', confidence: phaseA.predictiveScore, amount_usdt: 50000, reasoning: 'phase a' },
    route,
    'kis',
  );
  assert.ok(adjusted.amount_usdt > 0);
  assert.ok(String(adjusted.reasoning).includes('전략품질'));

  const runtime = await runLunaAnalysisPredictionPhaseA({ fixture: true, write: false });
  assert.equal(runtime.ok, true);
  assert.equal(runtime.shadowOnly, true);
  assert.equal(runtime.shadowLogLedger.writeApplied, false);

  const partialRuntime = await runLunaAnalysisPredictionPhaseA({ fixture: false, fetchBars: false, write: false });
  assert.equal(partialRuntime.ok, false);
  assert.equal(partialRuntime.strategyRoute, null);
  assert.equal(partialRuntime.adjustedDecision, null);
  assert.equal(partialRuntime.shadowLogLedger.reason, 'phase_a_not_ready');

  const runtimeWithProvidedBars = await runLunaAnalysisPredictionPhaseA({
    fixture: false,
    write: false,
    bars,
    marketDataSource: 'smoke_provided_bars',
  });
  assert.equal(runtimeWithProvidedBars.ok, true);
  assert.equal(runtimeWithProvidedBars.marketData.source, 'smoke_provided_bars');
  assert.equal(runtimeWithProvidedBars.marketData.bars, bars.length);

  const batchRuntime = await runLunaAnalysisPredictionPhaseABatch({
    market: 'domestic',
    symbols: '005930,000660',
    write: false,
    getOhlcv: async () => bars.map((bar, index) => [index, bar.open, bar.high, bar.low, bar.close, bar.volume]),
  });
  assert.equal(batchRuntime.ok, true);
  assert.equal(batchRuntime.symbols, 2);
  assert.equal(batchRuntime.ready, 2);

  const promotionGate = await runLunaAnalysisPredictionPhaseAPromotionGate({
    write: false,
    market: 'domestic',
    query: async () => [{
      symbol: '005930',
      market: 'domestic',
      hmm_samples: 8,
      shadow_days: 8,
      latest_observed_at: new Date().toISOString(),
      avg_regime_confidence: 0.71,
      garch_samples: 8,
      avg_position_size_factor: 0.86,
      sentiment_samples: 8,
      avg_sentiment_score: 0.12,
      alpha_samples: 160,
      alpha_shadow_days: 8,
      avg_alpha_composite: 0.09,
    }],
  });
  assert.equal(promotionGate.ok, true);
  assert.equal(promotionGate.summary.ready, 1);
  assert.equal(promotionGate.candidates[0].canPromote, false);
  assert.equal(promotionGate.candidates[0].activeBiasWeight, 0.5);

  const promotionGateSchemaCalls = [];
  await runLunaAnalysisPredictionPhaseAPromotionGate({
    write: false,
    market: 'domestic',
    query: async () => [],
    run: async (sql, params = []) => {
      promotionGateSchemaCalls.push({ sql, params });
      return { rowCount: 1 };
    },
  });
  assert.equal(promotionGateSchemaCalls.length, 0);

  await runLunaAnalysisPredictionPhaseAPromotionGate({
    write: false,
    market: 'domestic',
    ensureSchema: true,
    query: async () => [],
    run: async (sql, params = []) => {
      promotionGateSchemaCalls.push({ sql, params });
      return { rowCount: 1 };
    },
  });
  assert.ok(promotionGateSchemaCalls.some((call) => String(call.sql).includes('CREATE TABLE IF NOT EXISTS investment.hmm_regime_log')));

  const writeCalls = [];
  const appliedRuntime = await runLunaAnalysisPredictionPhaseA({
    fixture: true,
    write: false,
    apply: true,
    confirm: PHASE_A_SHADOW_LOG_CONFIRM,
    run: async (sql, params = []) => {
      writeCalls.push({ sql, params });
      return { rowCount: 1 };
    },
  });
  assert.equal(appliedRuntime.shadowLogLedger.writeApplied, true);
  assert.equal(appliedRuntime.shadowLogLedger.rows, 23);
  assert.equal(writeCalls.some((call) => String(call.sql).includes('INSERT INTO investment.hmm_regime_log')), true);
  assert.equal(writeCalls.some((call) => String(call.sql).includes('INSERT INTO investment.worldquant_alpha_log')), true);

  return {
    ok: true,
    smoke: 'luna-analysis-prediction-phase-a',
    modules: {
      hmm: hmm.status,
      garch: garch.status,
      finbert: finbert.status,
      worldquant: worldquant.status,
    },
    predictiveScore: phaseA.predictiveScore,
    selectedFamily: route.selectedFamily,
    migration: '20260525000001_luna_analysis_prediction_phase_a_logs.sql',
    shadowOnly: true,
  };
}

async function main() {
  const result = await runLunaAnalysisPredictionPhaseASmoke();
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-analysis-prediction-phase-a-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-analysis-prediction-phase-a-smoke error:' });
}
