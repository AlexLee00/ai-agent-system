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
