#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  BASE_FUSION_WEIGHTS,
  BASE_SIGNAL_WEIGHTS,
  _testOnly,
  getLatestRegimeWeights,
} from '../shared/regime-weight-learner.ts';
import { sanitizeLunaLearnedBiasWeightMap } from '../shared/luna-data-contracts.ts';
import { REGIME_AXIS_WEIGHTS } from '../shared/dynamic-universe-selector.ts';
import { buildLunaLearnedBiasFeedInput } from '../../sigma/shared/luna-learned-bias-feed.ts';

const { buildVaultRegimeWeights, timeStageDecayMultiplier } = _testOnly;

function vaultRow(overrides = {}) {
  const regime = overrides.regime || 'VOLATILE';
  const createdAt = overrides.createdAt || '2026-07-14T00:00:00.000Z';
  const id = String(overrides.id || '100');
  return {
    id,
    time_stage: overrides.timeStage || 'raw',
    created_at: createdAt,
    meta: {
      constitutionAllowed: true,
      createdAt,
      payload: {
        snapshotId: id,
        symbol: `__REGIME_${regime}__`,
        regime,
        weightUnit: 'ratio_0_1',
        fusionWeights: overrides.fusionWeights ?? BASE_FUSION_WEIGHTS[regime],
        signalWeights: overrides.signalWeights ?? BASE_SIGNAL_WEIGHTS[regime],
        universeWeights: overrides.universeWeights ?? { cap: 0.4, sector: 0.2, volume: 0.4 },
        totalTrades: overrides.totalTrades ?? 30,
        winRate: 0.6,
        profitFactor: 1.4,
        performanceMetric: 0.84,
        learnRate: 0.08,
      },
      libraryCoords: {
        abstraction_level: 'L0',
        time_stage: overrides.timeStage || 'raw',
        validation_state: 'observed',
        prediction_state: 'none',
      },
    },
  };
}

export async function runLunaLearnedBiasVaultSmoke() {
  const contract = sanitizeLunaLearnedBiasWeightMap({
    momentum: 0.2,
    breakout: '0.3',
    defensive: 99,
    unknown_factor: 0.1,
  }, { allowedKeys: Object.keys(BASE_SIGNAL_WEIGHTS.VOLATILE) });
  assert.deepEqual(contract.weights, { momentum: 0.2, breakout: 0.3 });
  assert.deepEqual(contract.rejected.map((item) => item.key).sort(), ['defensive', 'unknown_factor']);
  assert.equal(contract.unit, 'ratio_0_1');

  const malformedContract = sanitizeLunaLearnedBiasWeightMap({
    momentum: true,
    breakout: [],
    mean_reversion: ' ',
    defensive: '0.2',
  }, { allowedKeys: Object.keys(BASE_SIGNAL_WEIGHTS.VOLATILE) });
  assert.deepEqual(malformedContract.weights, { defensive: 0.2 });
  assert.deepEqual(
    malformedContract.rejected.map((item) => [item.key, item.reason]).sort(),
    [
      ['breakout', 'non_numeric_ratio'],
      ['mean_reversion', 'non_numeric_ratio'],
      ['momentum', 'non_numeric_ratio'],
    ],
  );

  const feedRecord = buildLunaLearnedBiasFeedInput({
    id: 204,
    regime: 'VOLATILE',
    fusion_weights: BASE_FUSION_WEIGHTS.VOLATILE,
    signal_weights: BASE_SIGNAL_WEIGHTS.VOLATILE,
    universe_weights: { cap: 0.4, sector: 0.2, volume: 0.4 },
    win_rate: 1 / 3,
    profit_factor: 0.2,
    performance_metric: 0.066,
    total_trades: 3,
    learn_rate: 0.08,
    created_at: '2026-07-13T22:00:05.042Z',
  });
  assert.equal(feedRecord.sourceKind, 'luna_learned_bias');
  assert.equal(feedRecord.payload.symbol, '__REGIME_VOLATILE__');
  assert.equal(feedRecord.payload.weightUnit, 'ratio_0_1');
  assert.match(feedRecord.text, /VOLATILE/);

  const older = vaultRow({
    id: '100',
    createdAt: '2026-07-13T00:00:00.000Z',
    signalWeights: { momentum: 0.2, breakout: 0.2, mean_reversion: 0.2, defensive: 0.4 },
  });
  const newerPartial = vaultRow({
    id: '101',
    createdAt: '2026-07-14T00:00:00.000Z',
    signalWeights: { momentum: 0.5 },
    fusionWeights: {},
    universeWeights: {},
  });
  const sameTimeHigherId = vaultRow({
    id: '102',
    createdAt: '2026-07-14T00:00:00.000Z',
    signalWeights: { momentum: 0.55 },
    fusionWeights: {},
    universeWeights: {},
  });
  const malformedNewest = vaultRow({
    id: '103',
    createdAt: '2026-07-15T00:00:00.000Z',
    signalWeights: { defensive: 9 },
    fusionWeights: {},
    universeWeights: {},
  });
  const selected = buildVaultRegimeWeights([
    older,
    malformedNewest,
    newerPartial,
    sameTimeHigherId,
  ], 'VOLATILE');
  assert.equal(selected.length, 1);
  assert.equal(selected[0].selectedFactors.signalWeights.momentum.value, 0.55);
  assert.equal(selected[0].selectedFactors.signalWeights.momentum.sourceId, '102');
  assert.equal(selected[0].selectedFactors.signalWeights.breakout.sourceId, '100');
  assert.equal(selected[0].selectedFactors.signalWeights.defensive.sourceId, '100');
  assert.equal(selected[0].source, 'sigma_vault');
  assert.equal(selected[0].rejectedFactors.some((item) => item.factor === 'defensive'), true);

  const fusionOnly = buildVaultRegimeWeights([vaultRow({
    id: '104',
    fusionWeights: { ta: 0.3 },
    signalWeights: {},
    universeWeights: {},
  })], 'VOLATILE');
  assert.equal(fusionOnly.length, 1);
  assert.equal(fusionOnly[0].selectedFactors.fusionWeights.ta.sourceId, '104');
  assert.deepEqual(fusionOnly[0].signalWeights, BASE_SIGNAL_WEIGHTS.VOLATILE);

  const selectedReversed = buildVaultRegimeWeights([
    sameTimeHigherId,
    newerPartial,
    malformedNewest,
    older,
  ], 'VOLATILE');
  assert.deepEqual(selectedReversed, selected);

  assert.equal(timeStageDecayMultiplier('raw'), 1);
  assert.equal(timeStageDecayMultiplier('digest'), 0.75);
  assert.equal(timeStageDecayMultiplier('pattern'), 0.5);
  assert.equal(timeStageDecayMultiplier('dormant'), 0.25);
  assert.equal(timeStageDecayMultiplier('forgotten'), 0);
  const decayed = buildVaultRegimeWeights([vaultRow({
    id: '200',
    timeStage: 'digest',
    signalWeights: { momentum: 0.45, breakout: 0.1, mean_reversion: 0.1, defensive: 0.35 },
  })], 'VOLATILE')[0];
  assert.ok(decayed.signalWeights.momentum > BASE_SIGNAL_WEIGHTS.VOLATILE.momentum);
  assert.ok(decayed.signalWeights.momentum < 0.45);
  assert.ok(decayed.signalWeights.defensive < BASE_SIGNAL_WEIGHTS.VOLATILE.defensive);
  assert.ok(decayed.signalWeights.defensive > 0.35);

  const zeroVector = buildVaultRegimeWeights([vaultRow({
    id: '201',
    fusionWeights: { ta: 0, fundamental: 0, sentiment: 0, worldquant: 0 },
    signalWeights: { momentum: 0, breakout: 0, mean_reversion: 0, defensive: 0 },
    universeWeights: { volume: 0, cap: 0, sector: 0 },
  })], 'VOLATILE')[0];
  assert.deepEqual(zeroVector.fusionWeights, BASE_FUSION_WEIGHTS.VOLATILE);
  assert.deepEqual(zeroVector.signalWeights, BASE_SIGNAL_WEIGHTS.VOLATILE);
  assert.deepEqual(zeroVector.universeWeights, REGIME_AXIS_WEIGHTS.VOLATILE);

  const fallbackRows = [{
    id: 204,
    regime: 'VOLATILE',
    fusion_weights: BASE_FUSION_WEIGHTS.VOLATILE,
    signal_weights: BASE_SIGNAL_WEIGHTS.VOLATILE,
    universe_weights: { cap: 0.4, sector: 0.2, volume: 0.4 },
    win_rate: 1 / 3,
    profit_factor: 0.2,
    performance_metric: 0.066,
    total_trades: 3,
    created_at: '2026-07-13T22:00:05.042Z',
  }];
  const coldStart = await getLatestRegimeWeights('VOLATILE', {
    vaultRowsProvider: async () => [],
    snapshotRowsProvider: async () => fallbackRows,
  });
  assert.equal(coldStart.length, 1);
  assert.equal(coldStart[0].source, 'snapshot_fallback');
  assert.deepEqual(coldStart[0].signalWeights, BASE_SIGNAL_WEIGHTS.VOLATILE);

  const vaultPreferred = await getLatestRegimeWeights('VOLATILE', {
    vaultRowsProvider: async () => [sameTimeHigherId, older],
    snapshotRowsProvider: async () => {
      throw new Error('snapshot fallback must not run when vault data is usable');
    },
  });
  assert.equal(vaultPreferred[0].source, 'sigma_vault');
  assert.equal(vaultPreferred[0].selectedFactors.signalWeights.momentum.value, 0.55);

  const mixedSources = await getLatestRegimeWeights(null, {
    vaultRowsProvider: async () => [sameTimeHigherId, older],
    snapshotRowsProvider: async () => [
      fallbackRows[0],
      {
        ...fallbackRows[0],
        id: 205,
        regime: 'RANGING',
        fusion_weights: BASE_FUSION_WEIGHTS.RANGING,
        signal_weights: BASE_SIGNAL_WEIGHTS.RANGING,
      },
    ],
  });
  assert.deepEqual(mixedSources.map((row) => [row.regime, row.source]), [
    ['RANGING', 'snapshot_fallback'],
    ['VOLATILE', 'sigma_vault'],
  ]);

  return {
    ok: true,
    smoke: 'luna-learned-bias-vault',
    scenarios: {
      unitContract: true,
      malformedRatioRejected: true,
      zeroVectorFallback: true,
      deterministicDuplicateFactor: true,
      outlierIsolation: true,
      directionPreservedThroughDecay: true,
      partialUpdateMerge: true,
      concurrentOrderingStable: true,
      coldStartSnapshotFallback: true,
      rawFeedRecord: true,
    },
  };
}

const result = await runLunaLearnedBiasVaultSmoke();
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else console.log('luna learned bias vault smoke ok');
