#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import * as db from '../shared/db.ts';
import {
  combineMarketGateSignals,
  computeAllMarketDeploymentGates,
  computeMarketDeploymentGate,
  ensureMarketGateHistorySchema,
  formatMarketGateDailyLine,
  LUNA_MARKET_GATE_DEFAULTS,
  LUNA_MARKET_GATE_PARAM_KEYS,
  regimeDirectionScore,
} from '../shared/luna-market-deployment-gate.ts';
import { runLunaMarketGate } from './runtime-luna-market-gate.ts';
import { LUNA_COMPONENT_REGISTRY_SEED, seedLunaComponentRegistry } from './luna-registry-seed.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const ROLLBACK_SENTINEL = 'luna_market_gate_smoke_rollback';
const PARAMS = {
  ...LUNA_MARKET_GATE_DEFAULTS,
  fullThreshold: 70,
  reducedThreshold: 40,
  reducedSizeMultiplier: 0.6,
  usTransitionWeight: 0.2,
  regimeDirectionWeight: 1.5,
};

function fixtureSignals(scores: number[], weight = 1) {
  return scores.map((score, idx) => ({
    name: `fixture_${idx + 1}`,
    score,
    weight,
    raw: { score },
    available: true,
    source: 'fixture',
  }));
}

async function withRollback(work: any) {
  let output;
  try {
    await db.withTransaction(async (tx: any) => {
      await ensureMarketGateHistorySchema(tx.run);
      output = await work(tx);
      throw new Error(ROLLBACK_SENTINEL);
    });
  } catch (error) {
    if (error?.message !== ROLLBACK_SENTINEL) throw error;
    return output;
  }
  throw new Error('luna_market_gate_smoke_expected_rollback');
}

async function main() {
  const normal = combineMarketGateSignals('crypto', fixtureSignals([80, 76, 74, 82]), PARAMS, new Date('2026-06-11T00:00:00Z'));
  assert.equal(normal.deployment, 'full');
  assert.equal(normal.score, 78);
  assert.equal(regimeDirectionScore('bull', 0.167752), 83.55);
  assert.equal(regimeDirectionScore('bear', -0.114846), 27.03);
  assert.equal(regimeDirectionScore('sideways', -0.036081), 50);

  const missing = combineMarketGateSignals('domestic', [
    ...fixtureSignals([60, 40]),
    { name: 'missing', score: null, weight: 5, available: false, source: 'fixture' },
  ], PARAMS, new Date('2026-06-11T00:00:00Z'));
  assert.equal(missing.availableSignalCount, 2);
  assert.equal(missing.deployment, 'reduced');
  assert.equal(missing.score, 50);

  const unknown = combineMarketGateSignals('overseas', fixtureSignals([90]), PARAMS, new Date('2026-06-11T00:00:00Z'));
  assert.equal(unknown.deployment, 'unknown');
  assert.equal(unknown.effectiveDeployment, 'reduced');

  const thresholdOverride = await computeMarketDeploymentGate('crypto', {
    params: { ...PARAMS, fullThreshold: 90, reducedThreshold: 45 },
    signalInputs: { crypto: fixtureSignals([80, 80]) },
    usGate: { score: 80, deployment: 'full' },
  });
  assert.equal(thresholdOverride.deployment, 'reduced');

  const highUs = await computeMarketDeploymentGate('domestic', {
    params: PARAMS,
    signalInputs: { domestic: fixtureSignals([60, 60]) },
    usGate: { score: 90, deployment: 'full' },
  });
  const lowUs = await computeMarketDeploymentGate('domestic', {
    params: PARAMS,
    signalInputs: {
      domestic: [
        ...fixtureSignals([60, 60]),
        { name: 'us_gate_transition', score: 10, weight: 0.2, available: true, source: 'fixture' },
      ],
    },
    usGate: { score: 10, deployment: 'halt' },
  });
  assert.ok(lowUs.score < highUs.score);

  const failure = await computeMarketDeploymentGate('crypto', {
    params: PARAMS,
    collectors: {
      crypto: async () => {
        throw new Error('network_down');
      },
    },
    usGate: { score: 70, deployment: 'reduced' },
  });
  assert.equal(failure.deployment, 'unknown');
  assert.equal(failure.signals[0].available, false);

  const emptyOnchain = await computeMarketDeploymentGate('crypto', {
    params: PARAMS,
    btcTicker: null,
    onchainSummary: {},
    usGate: { score: 70, deployment: 'reduced' },
  });
  const emptyOnchainSignal = emptyOnchain.signals.find((item) => item.name === 'btc_onchain_flow');
  assert.equal(emptyOnchainSignal?.available, false);
  assert.equal(emptyOnchainSignal?.error, 'empty_onchain_summary');

  const currentFixtureRegimeByMarket = new Map([
    ['overseas', { market: 'overseas', dominant: 'bear', confidence: 0.3284, source: 'hmm', features: { momentum20: -0.114846 } }],
    ['domestic', { market: 'domestic', dominant: 'bull', confidence: 0.5368, source: 'hmm', features: { momentum20: 0.167752 } }],
    ['crypto', { market: 'crypto', dominant: 'sideways', confidence: 0.1775, source: 'hmm', features: { momentum20: -0.036081 } }],
  ]);
  const overseasRegimeCombined = combineMarketGateSignals('overseas', [
    { name: 'vix_level', score: 70.04, weight: 1.2, available: true, source: 'fixture' },
    { name: 'us_benchmark_trend', score: 0, weight: 1, available: true, source: 'fixture' },
    { name: 'regime_direction', score: regimeDirectionScore('bear', -0.114846), weight: 1.5, available: true, source: 'luna-regime-engine' },
  ], PARAMS, new Date('2026-06-11T00:00:00Z'));
  assert.equal(overseasRegimeCombined.deployment, 'halt');

  const domesticRegimeCombined = combineMarketGateSignals('domestic', [
    { name: 'kospi_realized_vol_proxy', score: 0, weight: 1, available: true, source: 'fixture' },
    { name: 'korea_shadow_flow', score: 50, weight: 1, available: true, source: 'fixture' },
    { name: 'usdkrw_momentum', score: 50, weight: 0.8, available: true, source: 'fixture' },
    { name: 'us_gate_transition', score: 38.2, weight: 0.2, available: true, source: 'fixture' },
    { name: 'regime_direction', score: regimeDirectionScore('bull', 0.167752), weight: 1.5, available: true, source: 'luna-regime-engine' },
  ], PARAMS, new Date('2026-06-11T00:00:00Z'));
  assert.equal(domesticRegimeCombined.deployment, 'reduced');
  assert.ok(domesticRegimeCombined.score >= 49 && domesticRegimeCombined.score <= 50);

  const cryptoRegimeCombined = combineMarketGateSignals('crypto', [
    { name: 'btc_realized_vol_proxy', score: 22.66, weight: 1, available: true, source: 'fixture' },
    { name: 'btc_onchain_flow', score: 48.58, weight: 1, available: true, source: 'fixture' },
    { name: 'btc_funding_rate', score: 96.18, weight: 0.8, available: true, source: 'fixture' },
    { name: 'us_gate_transition', score: 38.2, weight: 0.2, available: true, source: 'fixture' },
    { name: 'regime_direction', score: regimeDirectionScore('sideways', -0.036081), weight: 1.5, available: true, source: 'luna-regime-engine' },
  ], PARAMS, new Date('2026-06-11T00:00:00Z'));
  assert.equal(cryptoRegimeCombined.deployment, 'reduced');

  const domesticCollectorRegime = await computeMarketDeploymentGate('domestic', {
    params: PARAMS,
    queryFn: async (sql) => {
      if (String(sql).includes('korea_public_data_shadow_signals')) return [];
      if (String(sql).includes('fx_rates')) return [{ inverse_rate: 1360 }, { inverse_rate: 1360 }];
      return [];
    },
    domesticRegime: { regime: 'volatile', bias: 'bearish', snapshots: [{ dayChangePct: 6.24, trendPct: 16.8 }] },
    regimeByMarket: currentFixtureRegimeByMarket,
    usGate: { score: 38.2, deployment: 'halt' },
  });
  const domesticRegimeSignal = domesticCollectorRegime.signals.find((item) => item.name === 'regime_direction');
  assert.equal(domesticRegimeSignal?.source, 'luna-regime-engine');
  assert.equal(domesticRegimeSignal?.score, 83.55);

  const requestedKeys = [];
  await computeMarketDeploymentGate('crypto', {
    getParameterFn: async (key) => {
      requestedKeys.push(key);
      if (key === LUNA_MARKET_GATE_PARAM_KEYS.regimeDirectionWeight) return { value: 2 };
      return { value: PARAMS[key] ?? LUNA_MARKET_GATE_DEFAULTS[Object.entries(LUNA_MARKET_GATE_PARAM_KEYS).find(([, value]) => value === key)?.[0]] };
    },
    signalInputs: { crypto: fixtureSignals([70, 70]) },
    usGate: { score: 70, deployment: 'reduced' },
  });
  assert.ok(requestedKeys.includes('g0.market_gate.regime_direction_weight'));

  const dbStamp = new Date(Date.now() + 60_000).toISOString();
  const dbResult = await withRollback(async (tx: any) => {
    const gates = (await computeAllMarketDeploymentGates({
      params: PARAMS,
      signalInputs: {
        overseas: fixtureSignals([72, 74]),
        domestic: fixtureSignals([50, 60]),
        crypto: fixtureSignals([80, 78]),
      },
      usGate: { score: 73, deployment: 'full' },
    })).map((gate) => ({ ...gate, computedAt: dbStamp }));
    const result = await runLunaMarketGate({
      gates,
      regimes: [],
      strategySignals: [],
      preflightEvaluations: [],
      circuitLocks: [],
      writeOutput: false,
    }, { runFn: tx.run, queryFn: tx.query });
    const rowsInTx = await tx.query(
      `SELECT COUNT(*)::int AS count
         FROM luna_market_gate_history
        WHERE computed_at = $1`,
      [dbStamp],
    );
    assert.equal(Number(rowsInTx?.[0]?.count || 0), 3);
    return result;
  });
  assert.equal(dbResult.inserted.length, 3);

  const afterRollback = await db.query(
    `SELECT COUNT(*)::int AS count
       FROM luna_market_gate_history
      WHERE computed_at = $1`,
    [dbStamp],
  ).catch(() => [{ count: 0 }]);
  assert.equal(Number(afterRollback?.[0]?.count || 0), 0);

  let gateRegimeByMarket = null;
  const runnerRegimeResult = await runLunaMarketGate({
    dryRun: true,
    writeOutput: false,
    strategySignals: [],
    preflightEvaluations: [],
    circuitLocks: [],
  }, {
    computeAllRegimeStates: async () => Array.from(currentFixtureRegimeByMarket.values()),
    computeAllMarketDeploymentGates: async (gateOptions) => {
      gateRegimeByMarket = gateOptions.regimeByMarket;
      return [
        { market: 'overseas', score: 40, deployment: 'reduced' },
        { market: 'domestic', score: 50, deployment: 'reduced' },
        { market: 'crypto', score: 55, deployment: 'reduced' },
      ];
    },
  });
  assert.equal(runnerRegimeResult.regimes.length, 3);
  assert.equal(gateRegimeByMarket?.get('domestic')?.dominant, 'bull');

  const line = formatMarketGateDailyLine([
    { market: 'overseas', score: 78, deployment: 'full' },
    { market: 'domestic', score: 56, deployment: 'reduced' },
    { market: 'crypto', score: 71, deployment: 'full' },
  ]);
  assert.equal(line, '게이트: US full(78)·KR reduced(56)·crypto full(71)');

  assert.equal(LUNA_COMPONENT_REGISTRY_SEED.some((row) => row.component === 'market-deployment-gate'), true);
  const seedDryRun = await seedLunaComponentRegistry({ dryRun: true });
  assert.equal(seedDryRun.components.filter((item) => item === 'market-deployment-gate').length, 1);

  return {
    ok: true,
    smoke: 'luna-market-gate',
    scenarios: {
      normal: normal.deployment,
      missing: missing.deployment,
      unknown: unknown.deployment,
      thresholdOverride: thresholdOverride.deployment,
      transitionLowersScore: lowUs.score < highUs.score,
      fetchFailureTolerated: failure.deployment,
      emptyOnchainUnavailable: true,
      regimeDirectionDomestic: domesticRegimeCombined.deployment,
      regimeDirectionOverseas: overseasRegimeCombined.deployment,
      regimeDirectionCrypto: cryptoRegimeCombined.deployment,
      regimeDirectionSource: domesticRegimeSignal?.source,
      regimeDirectionParameterLookup: requestedKeys.includes('g0.market_gate.regime_direction_weight'),
      runnerRegimePassedToGate: gateRegimeByMarket?.get('domestic')?.dominant === 'bull',
      dbRollback: true,
      reportLine: line,
      registrySeed: true,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: '❌ luna-market-gate-smoke 실패:',
  });
}

export { main as runLunaMarketGateSmoke };
