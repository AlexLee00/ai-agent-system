#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  C17_PARAMETER_SQL,
  GENETIC_REPORT_SQL,
  buildLunaPhase5GeneticReport,
  runLunaPhase5GeneticReport,
} from './luna-phase5-genetic-report.ts';
import { LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES } from './luna-data-contract-boundary-fixtures.ts';

const BASE_CHROMOSOME = Object.freeze({
  setupFamily: 'phase4_best_params_refinement',
  stopLossPct: -2,
  takeProfitPct: 6,
  maxDrawdownPct: 20,
  paperOnlyDays: 7,
  indicators: {
    macdHistogramMin: 0,
    bollingerPositionMax: 0.8,
    rsiOversold: 28,
  },
});

function geneticRows(count, options = {}) {
  const chromosome = options.chromosome || BASE_CHROMOSOME;
  return Array.from({ length: count }, (_, index) => ({
    id: String(index + 1),
    symbol: `${options.symbolPrefix || 'MOCK'}-${index % 4}`,
    market: 'crypto',
    exchange: 'binance',
    generation: options.generationOf?.(index) ?? 1,
    chromosome,
    fitness_score: options.fitnessOf?.(index) ?? 0.64 + (index % 3) * 0.01,
    fitness_unit: options.unitOf?.(index) ?? 'policy_score_0_1',
    observed_at: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
  }));
}

export async function runLunaPhase5GeneticReportSmoke() {
  assert.doesNotMatch(GENETIC_REPORT_SQL, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i);
  assert.doesNotMatch(C17_PARAMETER_SQL, /\b(?:INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i);
  assert.match(GENETIC_REPORT_SQL, /luna_phase5_genetic_alpha_shadow/);
  assert.match(GENETIC_REPORT_SQL, /ORDER BY observed_at DESC, id DESC/);

  const sufficientRows = geneticRows(60, {
    generationOf: (index) => index < 30 ? 1 : 2,
  });
  const currentParameters = [{
    key: 'c17.genetic.stop_loss_pct',
    scope: 'global',
    value: -1.5,
  }];
  const report = buildLunaPhase5GeneticReport(sufficientRows, currentParameters);
  assert.equal(report.source.requestedRelation, 'investment.luna_phase5_genetic_evolution');
  assert.equal(report.source.actualRelation, 'investment.luna_phase5_genetic_alpha_shadow');
  assert.equal(report.audit.rawRows, 60);
  assert.equal(report.topGenes[0].status, 'sufficient');
  assert.equal(report.topGenes[0].overfitGate.periodSplit.status, 'pass');
  assert.equal(report.topGenes[0].overfitGate.generationStability.status, 'pass');
  assert.equal(report.topGenes[0].overfitGate.status, 'pass');
  assert.equal(report.topGenes[0].currentStoreDistance.matchedParameters, 1);
  assert.equal(report.topGenes[0].currentStoreDistance.parameters[0].absoluteDistance, 0.5);
  assert.equal(report.topGenes[0].currentStoreDistance.parameters[0].geneUnit, 'signed_percentage_points');
  assert.equal(report.topGenes[0].currentStoreDistance.parameters[0].storeUnit, 'signed_percentage_points');
  assert.equal(report.costScenarios.every((scenario) => scenario.status === 'proxy_only_unit_mismatch'), true);
  assert.equal(
    report.topGenes[0].costAdjustedReevaluation.every((row, index, rows) => (
      index === 0 || row.penalizedFitnessProxy <= rows[index - 1].penalizedFitnessProxy
    )),
    true,
  );

  const insufficient = buildLunaPhase5GeneticReport(geneticRows(29), []);
  assert.equal(insufficient.topGenes[0].status, 'insufficient');
  assert.equal(insufficient.topGenes[0].overfitGate.status, 'insufficient');
  const threshold = buildLunaPhase5GeneticReport(geneticRows(30), []);
  assert.equal(threshold.topGenes[0].status, 'sufficient');

  const duplicateBase = geneticRows(30);
  const duplicateOlder = { ...duplicateBase[0], id: '100', fitness_score: 0.2 };
  const duplicateNewer = { ...duplicateBase[0], id: '101', fitness_score: 0.655 };
  const duplicateReport = buildLunaPhase5GeneticReport([
    ...duplicateBase.slice(1),
    duplicateNewer,
    duplicateOlder,
  ], []);
  assert.equal(duplicateReport.audit.duplicateRows, 1);
  assert.equal(duplicateReport.audit.conflictingDuplicateKeys, 1);
  assert.equal(duplicateReport.audit.dedupedRows, 30);
  assert.equal(duplicateReport.audit.outlierExcludedRows, 0);
  assert.equal(duplicateReport.topGenes[0].n, 30);

  const crossExchangeBase = geneticRows(30);
  const crossExchange = buildLunaPhase5GeneticReport([
    ...crossExchangeBase,
    ...crossExchangeBase.map((row, index) => ({
      ...row,
      id: String(index + 101),
      exchange: 'upbit',
    })),
  ], []);
  assert.equal(crossExchange.audit.rawRows, 60);
  assert.equal(crossExchange.audit.dedupedRows, 60);
  assert.equal(crossExchange.audit.duplicateRows, 0);
  assert.deepEqual(crossExchange.audit.exactDuplicateKey, [
    'symbol',
    'market',
    'exchange',
    'generation',
    'chromosome',
    'observed_at',
  ]);
  assert.equal(crossExchange.topGenes[0].n, 60);

  const mixedUnit = buildLunaPhase5GeneticReport([
    ...geneticRows(30),
    { ...geneticRows(1)[0], id: 'unit-mismatch', observed_at: '2027-01-01T00:00:00.000Z', fitness_unit: 'return_fraction' },
  ], []);
  assert.equal(mixedUnit.audit.invalidByReason.unitMismatch, 1);
  assert.equal(mixedUnit.audit.invalidRows, 1);

  const invalidRange = buildLunaPhase5GeneticReport(geneticRows(30, {
    fitnessOf: () => 25,
  }), []);
  assert.equal(invalidRange.audit.invalidByReason.outsideFitnessRange, 30);
  assert.equal(invalidRange.audit.invalidRows, 30);
  assert.equal(invalidRange.topGenes.length, 0);
  assert.equal(invalidRange.overfitGate.status, 'insufficient');

  const outlierSource = LUNA_DATA_CONTRACT_BOUNDARY_FIXTURES.outlierOutcomeRows
    .filter((row) => row.outcome_unit === 'return_fraction')
    .map((row, index) => ({
      ...geneticRows(1)[0],
      id: `outlier-${index}`,
      symbol: `OUTLIER-${index}`,
      fitness_score: index === 6 ? 0.95 : 0.5 + row.realized_reward,
      observed_at: new Date(Date.UTC(2026, 3, 1 + index)).toISOString(),
    }));
  const outlierReport = buildLunaPhase5GeneticReport(outlierSource, [], {
    minGroupN: 5,
    outlierMinGroupN: 5,
  });
  assert.equal(outlierReport.audit.outlierExcludedRows, 1);
  assert.equal(outlierReport.topGenes[0].n, 6);

  const baselineGene = geneticRows(90, {
    chromosome: { setupFamily: 'baseline_gene' },
    symbolPrefix: 'BASELINE',
    generationOf: (index) => index < 45 ? 1 : 2,
    fitnessOf: (index) => [0.49, 0.5, 0.51][index % 3],
  });
  const superiorGene = geneticRows(30, {
    chromosome: { setupFamily: 'superior_gene' },
    symbolPrefix: 'SUPERIOR',
    generationOf: (index) => index < 15 ? 1 : 2,
    fitnessOf: (index) => [0.795, 0.8, 0.805][index % 3],
  }).map((row, index) => ({ ...row, id: String(index + 1001) }));
  const geneLocalOutliers = buildLunaPhase5GeneticReport([
    ...baselineGene,
    ...superiorGene,
  ], []);
  assert.equal(geneLocalOutliers.audit.outlierExcludedRows, 0);
  assert.equal(geneLocalOutliers.topGenes[0].chromosome.setupFamily, 'superior_gene');
  assert.equal(geneLocalOutliers.topGenes[0].n, 30);

  const periodDrift = buildLunaPhase5GeneticReport(geneticRows(60, {
    generationOf: (index) => index < 30 ? 1 : 2,
    fitnessOf: (index) => index < 30 ? 0.8 : 0.5,
  }), []);
  assert.equal(periodDrift.topGenes[0].overfitGate.periodSplit.status, 'fail');
  assert.equal(periodDrift.topGenes[0].overfitGate.status, 'fail');

  const oneGeneration = buildLunaPhase5GeneticReport(geneticRows(60), []);
  assert.equal(oneGeneration.topGenes[0].overfitGate.periodSplit.status, 'pass');
  assert.equal(oneGeneration.topGenes[0].overfitGate.generationStability.status, 'insufficient');
  assert.equal(oneGeneration.topGenes[0].overfitGate.status, 'insufficient');
  assert.equal(oneGeneration.parameterDistribution.find((row) => row.parameter === 'stopLossPct').currentStore.status, 'unavailable');

  const sameTerminalName = buildLunaPhase5GeneticReport(sufficientRows, [{
    key: 'runtime_config.luna.strategyRouter.setupTypePolicy.breakout.stopLossPct',
    scope: 'global',
    value: 0.03,
  }]);
  assert.equal(sameTerminalName.topGenes[0].currentStoreDistance.status, 'unavailable');
  assert.equal(sameTerminalName.topGenes[0].currentStoreDistance.matchedParameters, 0);
  assert.equal(
    sameTerminalName.parameterDistribution.find((row) => row.parameter === 'stopLossPct').currentStore.status,
    'unavailable',
  );

  const wrongSetupFamily = buildLunaPhase5GeneticReport(geneticRows(60, {
    chromosome: { ...BASE_CHROMOSOME, setupFamily: 'genetic_hyperopt_candidate' },
    generationOf: (index) => index < 30 ? 1 : 2,
  }), currentParameters);
  assert.equal(wrongSetupFamily.topGenes[0].currentStoreDistance.status, 'unavailable');

  const wrongScope = buildLunaPhase5GeneticReport(sufficientRows, [{
    ...currentParameters[0],
    scope: 'strategy_family',
  }]);
  assert.equal(wrongScope.topGenes[0].currentStoreDistance.status, 'unavailable');

  const sameTimestamp = buildLunaPhase5GeneticReport(geneticRows(30, {
    generationOf: (index) => index < 15 ? 1 : 2,
  }).map((row) => ({
    ...row,
    symbol: `${row.symbol}-${row.id}`,
    observed_at: '2026-07-14T00:00:00.000Z',
  })), []);
  assert.equal(sameTimestamp.topGenes[0].status, 'sufficient');
  assert.equal(sameTimestamp.topGenes[0].overfitGate.generationStability.status, 'pass');
  assert.equal(sameTimestamp.topGenes[0].overfitGate.periodSplit.uniquePeriodN, 1);
  assert.equal(sameTimestamp.topGenes[0].overfitGate.periodSplit.status, 'insufficient');
  assert.equal(sameTimestamp.topGenes[0].overfitGate.status, 'insufficient');

  const queries = [];
  const runtime = await runLunaPhase5GeneticReport({ limit: 0 }, {
    query: async (sql) => {
      queries.push(sql);
      return queries.length === 1 ? sufficientRows : currentParameters;
    },
  });
  assert.equal(queries.length, 2);
  assert.equal(runtime.topGenes[0].n, 60);
  assert.match(runtime.summary, /generation stability/);

  return {
    status: 'ok',
    scenarios: 17,
    topGeneN: report.topGenes[0].n,
    outlierExcludedRows: outlierReport.audit.outlierExcludedRows,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = await runLunaPhase5GeneticReportSmoke();
  console.log(JSON.stringify(result, null, 2));
}
