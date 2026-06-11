#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runLunaMarketGate } from './runtime-luna-market-gate.ts';
import { LUNA_COMPONENT_REGISTRY_SEED, seedLunaComponentRegistry } from './luna-registry-seed.ts';
import {
  brierScore,
  buildRegimeCalibrationRow,
  computeRegimeState,
  ensureRegimeCalibrationSchema,
  ensureRegimeEngineHistorySchema,
  evaluateRegimeAlertPublication,
  fallbackProbabilities,
  insertRegimeCalibration,
  insertRegimeStateHistory,
  labelRealizedRegimeFromBars,
  processRegimeAlerts,
} from '../shared/luna-regime-engine.ts';

const ROLLBACK_SENTINEL = 'luna_regime_engine_smoke_rollback';

function fixtureBars(start = 100, step = 1, count = 12) {
  const base = Date.parse('2026-06-01T00:00:00Z');
  return Array.from({ length: count }, (_, idx) => {
    const close = start + step * idx;
    return {
      timestamp: new Date(base + idx * 86_400_000).toISOString(),
      open: close - 0.4,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000 + idx,
    };
  });
}

function hmmStub(regime = 'bull', probabilities = { bull: 0.7, bear: 0.1, sideways: 0.1, volatile: 0.1 }) {
  return () => ({
    ok: true,
    status: 'fixture_hmm_ready',
    currentRegime: regime,
    regimeProbabilities: probabilities,
    transitionMatrix: {},
    confidence: probabilities[regime] || 0.55,
    features: { fixture: true },
    shadowOnly: true,
  });
}

async function withRollback(work: any) {
  let output;
  try {
    await db.withTransaction(async (tx: any) => {
      output = await work(tx);
      throw new Error(ROLLBACK_SENTINEL);
    });
  } catch (error) {
    if (error?.message !== ROLLBACK_SENTINEL) throw error;
    return output;
  }
  throw new Error('luna_regime_engine_smoke_expected_rollback');
}

async function main() {
  const hmmState = await computeRegimeState('crypto', {
    bars: fixtureBars(),
    previousRows: [],
  }, {
    detectHMMRegime: hmmStub('bull', { bull: 0.7, bear: 0.1, sideways: 0.1, volatile: 0.1 }),
  });
  assert.equal(hmmState.source, 'hmm');
  assert.equal(hmmState.dominant, 'bull');
  const probabilitySum = Object.values(hmmState.probabilities).reduce((sum, value) => sum + Number(value), 0);
  assert.ok(Math.abs(probabilitySum - 1) < 0.00001);

  const fallbackState = await computeRegimeState('crypto', {
    bars: [],
    fetchBars: false,
    previousRows: [],
  }, {
    getMarketRegime: async () => ({ regime: 'trending_bear', confidence: 0.66, summary: 'fixture' }),
  });
  assert.equal(fallbackState.source, 'fallback');
  assert.equal(fallbackState.dominant, 'bear');
  assert.equal(fallbackState.probabilities.bear, 0.55);

  const changed = await computeRegimeState('overseas', {
    bars: fixtureBars(),
    previousRows: [{ current_regime: 'bull', regime_probabilities: { bull: 0.8, bear: 0.05, sideways: 0.1, volatile: 0.05 } }],
    parameters: { 'c2.transition_alert_threshold': 0.15 },
    now: '2026-06-11T01:00:00Z',
  }, {
    detectHMMRegime: hmmStub('bear', { bull: 0.05, bear: 0.75, sideways: 0.1, volatile: 0.1 }),
    getParameter: async () => null,
  });
  assert.equal(changed.transitionAlert?.type, 'dominant_changed');

  const stable = await computeRegimeState('overseas', {
    bars: fixtureBars(),
    previousRows: [{ current_regime: 'bear', regime_probabilities: { bull: 0.1, bear: 0.7, sideways: 0.1, volatile: 0.1 } }],
    parameters: { 'c2.transition_alert_threshold': 0.15 },
  }, {
    detectHMMRegime: hmmStub('bear', { bull: 0.1, bear: 0.78, sideways: 0.06, volatile: 0.06 }),
    getParameter: async () => null,
  });
  assert.equal(stable.transitionAlert, null);

  const cooldown = evaluateRegimeAlertPublication([
    { market: 'crypto', createdAt: '2026-06-11T10:00:00Z' },
  ], {
    alerts: [{ market: 'crypto', publishedAt: '2026-06-11T09:00:00Z' }],
  }, { transitionAlertCooldownHours: 4, transitionAlertDailyLimit: 3 }, new Date('2026-06-11T10:00:00Z'));
  assert.equal(cooldown.suppressed[0]?.suppressedReason, 'cooldown');
  const dailyLimit = evaluateRegimeAlertPublication([
    { market: 'domestic', createdAt: '2026-06-11T10:00:00Z' },
  ], {
    alerts: [{ market: 'crypto', publishedAt: '2026-06-11T00:30:00Z' }],
  }, { transitionAlertCooldownHours: 4, transitionAlertDailyLimit: 1 }, new Date('2026-06-11T10:00:00Z'));
  assert.equal(dailyLimit.suppressed[0]?.suppressedReason, 'daily_limit');

  assert.equal(brierScore({ bull: 1, bear: 0, sideways: 0, volatile: 0 }, 'bull'), 0);
  assert.equal(brierScore({ bull: 0.25, bear: 0.25, sideways: 0.25, volatile: 0.25 }, 'bull'), 0.75);

  assert.equal(labelRealizedRegimeFromBars([{ close: 100 }, { close: 100.6 }]).label, 'bull');
  assert.equal(labelRealizedRegimeFromBars([{ close: 100 }, { close: 99.4 }]).label, 'bear');
  assert.equal(labelRealizedRegimeFromBars([{ close: 100 }, { close: 100.1 }]).label, 'sideways');
  assert.equal(labelRealizedRegimeFromBars([{ close: 100 }, { close: 120 }, { close: 118 }]).label, 'bear');

  const alertFailure = await processRegimeAlerts([{
    ...hmmState,
    market: 'crypto',
    transitionAlert: { type: 'dominant_changed', previousDominant: 'bear', currentDominant: 'bull', createdAt: '2026-06-11T10:00:00Z' },
  }], {
    writeOutput: false,
    now: '2026-06-11T10:00:00Z',
    params: { transitionAlertCooldownHours: 4, transitionAlertDailyLimit: 1 },
  }, {
    publishAlert: async () => {
      throw new Error('fixture_alert_down');
    },
  });
  assert.equal(alertFailure.publishedCount, 0);
  assert.equal(alertFailure.alerts[0]?.publishError, 'fixture_alert_down');

  const gateFailure = await runLunaMarketGate({
    dryRun: true,
    writeOutput: false,
    strategySignals: [],
    preflightEvaluations: [],
    circuitLocks: [],
  }, {
    computeAllMarketDeploymentGates: async () => {
      throw new Error('fixture_gate_down');
    },
    computeAllRegimeStates: async () => [hmmState],
    publishAlert: async () => true,
  });
  assert.equal(gateFailure.gateError, 'fixture_gate_down');
  assert.equal(gateFailure.regimes.length, 1);
  assert.ok(gateFailure.summary.includes('레짐:'));

  const stamp = new Date(Date.now() + 120_000).toISOString();
  const dbResult = await withRollback(async (tx: any) => {
    await ensureRegimeEngineHistorySchema(tx.run);
    await ensureRegimeCalibrationSchema(tx.run);
    const state = {
      ...hmmState,
      market: 'crypto',
      computedAt: stamp,
      transitionAlert: { type: 'dominant_probability_surge', currentDominant: 'bull', createdAt: stamp },
    };
    await insertRegimeStateHistory(state, tx.run);
    const calibration = buildRegimeCalibrationRow({
      market: 'crypto',
      asOfDate: stamp.slice(0, 10),
      label: 'bull',
      hmmProbabilities: state.probabilities,
      fallbackProbabilities: fallbackProbabilities('sideways'),
      metadata: { smoke: true },
    });
    await insertRegimeCalibration(calibration, tx.run);
    const logs = await tx.query(
      `SELECT COUNT(*)::int AS count
         FROM hmm_regime_log
        WHERE symbol = '__market__'
          AND market = 'crypto'
          AND transition_alert IS NOT NULL
          AND created_at >= NOW() - INTERVAL '5 minutes'`,
    );
    const rows = await tx.query(
      `SELECT COUNT(*)::int AS count
         FROM luna_regime_calibration
        WHERE market = 'crypto'
          AND as_of_date = $1`,
      [stamp.slice(0, 10)],
    );
    assert.ok(Number(logs?.[0]?.count || 0) >= 1);
    assert.ok(Number(rows?.[0]?.count || 0) >= 1);
    return { historyRows: Number(logs?.[0]?.count || 0), calibrationRows: Number(rows?.[0]?.count || 0) };
  });
  assert.ok(dbResult.historyRows >= 1);
  assert.ok(dbResult.calibrationRows >= 1);

  const seedDryRun = await seedLunaComponentRegistry({ dryRun: true });
  assert.equal(LUNA_COMPONENT_REGISTRY_SEED.length, 30);
  assert.equal(seedDryRun.seeded, 30);
  assert.equal(seedDryRun.components.includes('regime-engine-hmm'), true);

  return {
    ok: true,
    smoke: 'luna-regime-engine',
    scenarios: {
      hmmProbabilitySum: Number(probabilitySum.toFixed(6)),
      fallbackSource: fallbackState.source,
      transitionAlert: changed.transitionAlert?.type,
      stableAlert: stable.transitionAlert,
      cooldown: cooldown.suppressed[0]?.suppressedReason,
      dailyLimit: dailyLimit.suppressed[0]?.suppressedReason,
      brierUniformBull: 0.75,
      labels: ['bull', 'bear', 'sideways', 'latest_day_bear'],
      alertPublishFailSafe: alertFailure.alerts[0]?.publishError,
      marketGateIndependentFailure: gateFailure.gateError,
      dbRollback: true,
      registrySeedCount: seedDryRun.seeded,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: '❌ luna-regime-engine-smoke 실패:',
  });
}

export { main as runLunaRegimeEngineSmoke };
