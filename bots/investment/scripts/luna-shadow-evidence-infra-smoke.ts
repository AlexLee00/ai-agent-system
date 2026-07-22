#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { _testOnly as learnerTestOnly } from '../shared/regime-weight-learner.ts';
import {
  buildMlPredictionShadowRecord,
  matureMlPredictionShadow,
  persistMlPredictionShadow,
} from '../shared/ml-prediction-shadow.ts';
import { collectEntryPreflightEvidenceForEvaluation } from './luna-entry-trigger-worker.ts';
import { mapDeferredPreflightCounterfactualRow } from './runtime-luna-guard-counterfactual.ts';
import { attachSampleCounts } from './runtime-luna-registry-evaluator.ts';
import { LUNA_COMPONENT_REGISTRY_SEED } from './luna-registry-seed.ts';
import { runLunaNextbarShadowDaily } from './runtime-luna-nextbar-shadow-daily.ts';
import { getOpsSchedulerJobs } from './runtime-luna-ops-scheduler.ts';
import {
  buildNextbarExecutionComparisons,
  collectNextbarExecutionShadow,
} from '../shared/luna-nextbar-shadow-collector.ts';

async function testLearnedBiasContract() {
  const expected = {
    momentum: 'momentum',
    trend_following: 'momentum',
    momentum_rotation: 'momentum',
    equity_swing: 'momentum',
    breakout: 'breakout',
    mean_reversion: 'mean_reversion',
    defensive: 'defensive',
    defensive_rotation: 'defensive',
    promotion_ready_shadow: null,
    short_term_scalping: null,
    micro_swing: null,
    unknown_family: null,
  };
  for (const [label, learnerKey] of Object.entries(expected)) {
    assert.equal(learnerTestOnly.normalizeLearnerSignalType(label), learnerKey, label);
  }
  assert.equal(learnerTestOnly.resolveLearnerSignalType({
    route_family: 'promotion_ready_shadow',
    strategy_family: 'defensive_rotation',
  }), 'defensive');
  assert.equal(learnerTestOnly.resolveLearnerSignalType({
    route_family: 'promotion_ready_shadow',
    strategy_family: null,
    trade_mode: 'momentum',
  }), null, 'trade_mode must not be silently treated as a strategy family');
  const performance = learnerTestOnly.computeRegimePerformance([
    { regime: 'TRENDING_BULL', route_family: 'trend_following', total_trades: 4, win_trades: 3 },
    { regime: 'TRENDING_BULL', route_family: 'promotion_ready_shadow', strategy_family: 'defensive_rotation', total_trades: 2, win_trades: 1 },
    { regime: 'TRENDING_BULL', route_family: 'promotion_ready_shadow', strategy_family: null, trade_mode: 'momentum', total_trades: 5, win_trades: 5 },
  ]);
  assert.equal(performance.TRENDING_BULL.signalWins.momentum.total, 4);
  assert.equal(performance.TRENDING_BULL.signalWins.defensive.total, 2);

  let sampleSql = '';
  const rows = await attachSampleCounts([
    { component: 'learned-regime-bias', sample_count: 141 },
  ], {}, {
    queryFn: async (sql: string) => {
      sampleSql = sql;
      return [{ count: 0 }];
    },
  });
  assert.equal(rows[0].sample_count, 0);
  assert.match(sampleSql, /trade_journal/);
  assert.match(sampleSql, /learnedBias/);
  assert.match(sampleSql, /MIN\(/i);
  assert.match(sampleSql, /TRENDING_BULL/);
  assert.doesNotMatch(sampleSql, /luna_regime_weight_snapshots/);
}

async function testMlPersistenceContract() {
  const record = buildMlPredictionShadowRecord({
    forecastId: '00000000-0000-4000-8000-000000000092',
    symbol: 'BTC/USDT',
    market: 'crypto',
    source: 'task-0092-smoke',
    forecast: {
      exchange: 'binance',
      originCandleTs: '2026-07-22T00:00:00.000Z',
      originCandleClosed: true,
      timeframe: '1h',
      horizon: 5,
      shadowMode: true,
      dataHealth: 'ok',
      prediction: {
        currentPrice: 100,
        predictedPrice: 102,
        expectedReturn: 0.02,
        direction: 'up',
        confidence: 0.81,
        modelVersion: 'ml-price-predictor-v1',
        configVersion: 'holt-a0.25-b0.08-blend40-60',
      },
    },
  });
  assert.equal(record.forecastId, '00000000-0000-4000-8000-000000000092');
  assert.equal(record.symbol, 'BTC/USDT');
  assert.equal(record.exchange, 'binance');
  assert.equal(record.originCandleTs, '2026-07-22T00:00:00.000Z');
  assert.equal(record.targetCandleTs, '2026-07-22T05:00:00.000Z');
  assert.equal(record.predictedPrice, 102);
  assert.equal(record.shadowOnly, true);

  const persistSql = [];
  const persisted = await persistMlPredictionShadow(record, {
    queryFn: async (sql: string) => {
      persistSql.push(sql);
      if (sql.includes('to_regclass')) return [{ table_name: 'investment.luna_ml_prediction_shadow' }];
      return [{ forecast_id: record.forecastId }];
    },
  });
  assert.equal(persisted.status, 'inserted');
  assert.match(persistSql.join('\n'), /ON CONFLICT/);
  assert.match(persistSql.join('\n'), /shadow_only/);

  const missing = await persistMlPredictionShadow(record, {
    queryFn: async () => [{ table_name: null }],
  });
  assert.equal(missing.status, 'schema_missing');

  const maturitySql = [];
  const matured = await matureMlPredictionShadow({ limit: 25 }, {
    queryFn: async (sql: string) => {
      maturitySql.push(sql);
      if (sql.includes('to_regclass')) return [{ table_name: 'investment.luna_ml_prediction_shadow' }];
      return [{ matured_count: 2 }];
    },
  });
  assert.equal(matured.matured, 2);
  assert.match(maturitySql.join('\n'), /ohlcv_cache/);
  assert.match(maturitySql.join('\n'), /maturity_status/);

  const migration = fs.readFileSync(new URL('../migrations/20260722000001_luna_ml_prediction_shadow.sql', import.meta.url), 'utf8');
  for (const column of [
    'forecast_id', 'symbol', 'exchange', 'origin_candle_ts', 'timeframe', 'horizon',
    'origin_price', 'predicted_price', 'direction', 'confidence', 'model_version',
    'config_version', 'realized_price', 'realized_return', 'maturity_status',
  ]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`));
  }
  assert.match(migration, /GRANT SELECT ON TABLE investment\.luna_ml_prediction_shadow TO hub_readonly/);
  assert.match(migration, /GRANT USAGE ON SCHEMA investment TO hub_readonly/);
  assert.match(migration, /CHECK \(shadow_only IS TRUE\)/);

  const mlRegistry = LUNA_COMPONENT_REGISTRY_SEED.find((row) => row.component === 'ml-price-predictor');
  assert.equal(mlRegistry?.currentMode, 'shadow');
  assert.equal(mlRegistry?.criteria?.minSamples, 200);
  assert.match(String(mlRegistry?.criteria?.evidence || ''), /luna_ml_prediction_shadow/);
}

async function testPreflightCollectionAndOutcomeLink() {
  const calls = [];
  const collected = await collectEntryPreflightEvidenceForEvaluation({
    exchange: 'binance',
    result: {
      results: [
        { triggerId: 'fired-1', symbol: 'BTC/USDT', fired: true },
        { triggerId: 'blocked-1', symbol: 'ETH/USDT', fired: false, reason: 'active_entry_trigger_quality_gate_blocked' },
        { triggerId: 'waiting-1', symbol: 'SOL/USDT', fired: false, reason: 'conditions_not_met' },
      ],
    },
    riskContext: { capitalSnapshot: { buyableAmount: 50, minOrderAmount: 11 } },
    events: [],
    env: { ENTRY_PREFLIGHT_SHADOW_ENABLED: 'true' },
    deps: {
      triggerFetcher: async (id: string) => ({ id, symbol: id.startsWith('fired') ? 'BTC/USDT' : 'ETH/USDT', exchange: 'binance' }),
      recentPreflightFinder: async () => null,
      amountResolver: () => 50,
      preflightRunner: async ({ trigger, collectionContext }) => {
        calls.push({ triggerId: trigger.id, collectionContext });
        return {
          enabled: true,
          shadowEnabled: true,
          activeBlockEnabled: false,
          shadowId: `shadow:${trigger.id}`,
          preflight: { decision: 'defer_min_order', reason: 'fixture', wouldDefer: true },
        };
      },
    },
  });
  assert.equal(collected.collected, 2);
  assert.deepEqual(calls.map((row) => row.triggerId), ['fired-1', 'blocked-1']);
  assert.equal(collected.byTrigger.get('fired-1')?.shadowId, 'shadow:fired-1');
  assert.equal(calls.every((row) => row.collectionContext?.source === 'entry_trigger_evaluation'), true);

  const virtual = mapDeferredPreflightCounterfactualRow({
    id: 41,
    trigger_id: 'blocked-1',
    symbol: 'ETH/USDT',
    exchange: 'binance',
    preflight_decision: 'defer_min_order',
    preflight_reason: 'amount below minimum',
    created_at: '2026-07-22T01:00:00.000Z',
    target_price: 3000,
    stop_loss: 2940,
    take_profit: 3090,
  });
  assert.equal(virtual.id, 'entry_preflight:41');
  assert.equal(virtual.trigger_id, 'blocked-1');
  assert.equal(virtual.reason, 'entry_preflight:defer_min_order');
  assert.equal(virtual._source, 'entry_preflight_shadow');
  assert.equal(virtual.target_price, 3000);
}

async function testNextbarDailyContract() {
  const sameBar = [{ label: 'fixture', params: { strategy: 'ema', tp_pct: 0.03, sl_pct: 0.02 }, total_return: 0.04, total_trades: 3 }];
  const nextbar = [{ ...sameBar[0], total_return: 0.035, total_trades: 2 }];
  const comparison = buildNextbarExecutionComparisons({ sameBarRows: sameBar, nextbarRows: nextbar });
  assert.equal(comparison.matched, 1);
  assert.ok(Math.abs(comparison.comparisons[0].returnDelta + 0.005) < 1e-12);
  assert.equal(comparison.comparisons[0].tradeCountDelta, -1);

  const runnerCalls = [];
  const insertCalls = [];
  const direct = await collectNextbarExecutionShadow({
    symbol: 'BTC/USDT',
    now: '2026-07-22T03:10:00+09:00',
  }, {
    runner: (_symbol, _days, options) => {
      runnerCalls.push(options.env);
      return options.env.LUNA_BT_NEXT_BAR_EXECUTION_ENABLED === 'true' ? nextbar : sameBar;
    },
    queryFn: async (sql, params) => {
      insertCalls.push({ sql, params });
      return [{ id: 92 }];
    },
  });
  assert.equal(direct.persisted, 1);
  assert.deepEqual(runnerCalls.map((row) => row.LUNA_BT_NEXT_BAR_EXECUTION_ENABLED), ['false', 'true']);
  assert.match(insertCalls[0].sql, /WHERE NOT EXISTS/);
  assert.equal(JSON.parse(insertCalls[0].params[4]).shadowOnly, true);

  const preview = await runLunaNextbarShadowDaily({
    symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
    now: '2026-07-22T03:10:00+09:00',
  });
  assert.equal(preview.apply, false);
  assert.equal(preview.planned, 3);
  assert.equal(preview.written, 0);

  const denied = await runLunaNextbarShadowDaily({
    apply: true,
    confirm: 'wrong',
    symbols: ['BTC/USDT'],
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 'confirmation_required');

  const collected = [];
  const applied = await runLunaNextbarShadowDaily({
    apply: true,
    confirm: 'luna-nextbar-shadow-daily',
    symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
    now: '2026-07-22T03:10:00+09:00',
  }, {
    schemaAvailableFn: async () => true,
    hasDailyEvidenceFn: async (symbol: string) => symbol === 'ETH/USDT',
    collectFn: async (options) => {
      collected.push(options);
      return { ok: true, symbol: options.symbol, nextbarShadow: { persisted: 4 } };
    },
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.written, 8);
  assert.equal(applied.skippedExisting, 1);
  assert.deepEqual(collected.map((row) => row.symbol), ['BTC/USDT', 'SOL/USDT']);
  assert.equal(collected.every((row) => row.source === 'nextbar-shadow-daily'), true);
  assert.equal(collected.every((row) => row.shadowOnly === true), true);

  const job = getOpsSchedulerJobs().find((row) => row.name === 'nextbar_shadow_daily_multi_symbol');
  assert.equal(job?.category, 'evidence_shadow');
  assert.equal(job?.cadence?.type, 'daily');
  assert.equal(job?.args?.includes('--apply'), true);
  assert.equal(job?.args?.includes('--confirm=luna-nextbar-shadow-daily'), true);
  assert.equal(job?.args?.includes('--symbols=BTC/USDT,ETH/USDT,SOL/USDT'), true);

  const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(packageJson.scripts['runtime:luna-nextbar-shadow-daily']);
  assert.ok(packageJson.scripts['smoke:luna-shadow-evidence-infra']);
  assert.ok(packageJson.scripts['check:luna-shadow-evidence-infra']);
}

export async function runSmoke() {
  await testLearnedBiasContract();
  await testMlPersistenceContract();
  await testPreflightCollectionAndOutcomeLink();
  await testNextbarDailyContract();
  return {
    ok: true,
    shadowOnly: true,
    dbWrites: 0,
    liveMutation: false,
    tracks: ['learned_bias', 'ml_prediction', 'entry_preflight', 'nextbar'],
  };
}

runSmoke()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
