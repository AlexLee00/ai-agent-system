#!/usr/bin/env node
// @ts-nocheck
// Canonical smoke: operations DB contact is forbidden; persistence uses an in-memory sink.

import assert from 'assert/strict';
import {
  combineMarketGateSignals,
  computeAllMarketDeploymentGates,
  computeMarketDeploymentGate,
  ensureMarketGateHistorySchema,
  formatMarketGateDailyLine,
  LUNA_MARKET_GATE_DEFAULTS,
} from '../shared/luna-market-deployment-gate.ts';
import { runLunaMarketGate } from './runtime-luna-market-gate.ts';
import { LUNA_COMPONENT_REGISTRY_SEED, seedLunaComponentRegistry } from './luna-registry-seed.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const PARAMS = {
  ...LUNA_MARKET_GATE_DEFAULTS,
  fullThreshold: 70,
  reducedThreshold: 40,
  reducedSizeMultiplier: 0.6,
  usTransitionWeight: 0.2,
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

async function main() {
  const normal = combineMarketGateSignals('crypto', fixtureSignals([80, 76, 74, 82]), PARAMS, new Date('2026-06-11T00:00:00Z'));
  assert.equal(normal.deployment, 'full');
  assert.equal(normal.score, 78);

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

  const historyRows = [];
  const runFn = async (sql: string, params: any[] = []) => {
    if (/INSERT INTO luna_market_gate_history/i.test(sql)) {
      historyRows.push(params);
      return { rowCount: 1, rows: [{ id: historyRows.length }] };
    }
    return { rowCount: 0, rows: [] };
  };
  await ensureMarketGateHistorySchema(runFn);
  assert.equal(historyRows.length, 0);
  const historyStamp = new Date(Date.now() + 60_000).toISOString();
  const gates = (await computeAllMarketDeploymentGates({
    params: PARAMS,
    signalInputs: {
      overseas: fixtureSignals([72, 74]),
      domestic: fixtureSignals([50, 60]),
      crypto: fixtureSignals([80, 78]),
    },
    usGate: { score: 73, deployment: 'full' },
  })).map((gate) => ({ ...gate, computedAt: historyStamp }));
  const persisted = await runLunaMarketGate({
    gates,
    regimes: [],
    strategySignals: [],
    preflightEvaluations: [],
    circuitLocks: [],
    writeOutput: false,
  }, { runFn, queryFn: async () => [] });
  assert.equal(historyRows.length, 3);
  assert.equal(persisted.inserted.length, 3);

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
      inMemoryHistoryRows: historyRows.length,
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
