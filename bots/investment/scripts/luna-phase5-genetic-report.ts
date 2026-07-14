#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db/core.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { isolateLunaOutcomeOutliers } from '../shared/luna-data-contracts.ts';

const FITNESS_UNIT = 'policy_score_0_1';
const DEFAULT_MIN_GROUP_N = 30;
const DEFAULT_TOP_LIMIT = 10;
const DEFAULT_MAX_FITNESS_DRIFT = 0.1;

const C17_PARAMETER_SEMANTIC_MAP = Object.freeze({
  phase4_best_params_refinement: Object.freeze({
    stopLossPct: Object.freeze({
      storeKey: 'c17.genetic.stop_loss_pct',
      storeScope: 'global',
      geneUnit: 'signed_percentage_points',
      storeUnit: 'signed_percentage_points',
      conversion: 'identity',
      toStoreValue: (value) => value,
    }),
  }),
});

export const GENETIC_REPORT_SQL = `
  SELECT id::text, symbol, market, exchange, generation, chromosome,
         fitness_score, '${FITNESS_UNIT}'::text AS fitness_unit,
         promotion_status, blocked_reasons, observed_at
    FROM investment.luna_phase5_genetic_alpha_shadow
   WHERE shadow_only = true
     AND live_mutation = false
   ORDER BY observed_at DESC, id DESC
   LIMIT NULLIF($1::int, 0)
`;

export const C17_PARAMETER_SQL = `
  SELECT DISTINCT ON (key, scope)
         key, scope, value, effective_from, created_at
    FROM investment.luna_parameter_store
   WHERE effective_from <= NOW()
     AND key NOT LIKE 'smoke.%'
   ORDER BY key, scope, effective_from DESC, created_at DESC, id DESC
`;

export const GENETIC_COST_SCENARIOS = Object.freeze([
  Object.freeze({ name: 'low', feeBpsPerSide: 4, slippageBpsPerSide: 2 }),
  Object.freeze({ name: 'base', feeBpsPerSide: 10, slippageBpsPerSide: 5 }),
  Object.freeze({ name: 'stress', feeBpsPerSide: 10, slippageBpsPerSide: 15 }),
]);

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 6) {
  return value == null ? null : Number(Number(value).toFixed(digits));
}

function mean(values) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function compareIds(left, right) {
  const leftText = String(left ?? '');
  const rightText = String(right ?? '');
  if (/^\d+$/.test(leftText) && /^\d+$/.test(rightText)) {
    const leftNumber = BigInt(leftText);
    const rightNumber = BigInt(rightText);
    return leftNumber < rightNumber ? -1 : leftNumber > rightNumber ? 1 : 0;
  }
  return leftText.localeCompare(rightText);
}

function exactObservationKey(row) {
  const chromosome = parseJsonObject(row.chromosome);
  return [
    String(row.symbol || '').trim().toUpperCase(),
    String(row.market || '').trim().toLowerCase(),
    String(row.exchange || '').trim().toLowerCase(),
    String(row.generation ?? ''),
    chromosome ? stableStringify(chromosome) : String(row.chromosome ?? ''),
    String(row.observed_at ?? ''),
  ].join('|');
}

function duplicateConflictSignature(row) {
  return stableStringify({
    fitnessScore: row.fitness_score,
    fitnessUnit: row.fitness_unit,
    promotionStatus: row.promotion_status,
    blockedReasons: row.blocked_reasons,
  });
}

function dedupeExactObservations(rows) {
  const selected = new Map();
  const signatures = new Map();
  let duplicateRows = 0;
  for (const row of rows) {
    const key = exactObservationKey(row);
    if (!signatures.has(key)) signatures.set(key, new Set());
    signatures.get(key).add(duplicateConflictSignature(row));
    if (selected.has(key)) duplicateRows += 1;
    const current = selected.get(key);
    if (!current || compareIds(current.id, row.id) < 0) selected.set(key, row);
  }
  return {
    rows: [...selected.values()],
    duplicateRows,
    conflictingDuplicateKeys: [...signatures.values()].filter((values) => values.size > 1).length,
  };
}

function normalizeRow(row) {
  const chromosome = parseJsonObject(row.chromosome);
  const fitness = finiteOrNull(row.fitness_score ?? row.fitnessScore);
  const generation = finiteOrNull(row.generation);
  const observedAt = new Date(row.observed_at ?? row.observedAt);
  const symbol = String(row.symbol || '').trim().toUpperCase();
  const unit = String(row.fitness_unit ?? row.fitnessUnit ?? '').trim().toLowerCase();
  let invalidReason = null;
  if (!symbol) invalidReason = 'missingSymbol';
  else if (!chromosome) invalidReason = 'invalidChromosome';
  else if (fitness == null) invalidReason = 'nonFiniteFitness';
  else if (unit !== FITNESS_UNIT) invalidReason = 'unitMismatch';
  else if (fitness < 0 || fitness > 1) invalidReason = 'outsideFitnessRange';
  else if (generation == null || !Number.isInteger(generation) || generation < 1) invalidReason = 'invalidGeneration';
  else if (Number.isNaN(observedAt.getTime())) invalidReason = 'invalidObservedAt';
  if (invalidReason) return { invalidReason };
  const geneKey = stableStringify(chromosome);
  return {
    id: String(row.id ?? ''),
    symbol,
    market: String(row.market || '').trim().toLowerCase() || 'unknown',
    generation,
    chromosome,
    geneKey,
    fitness,
    realizedReward: fitness,
    outcomeUnit: FITNESS_UNIT,
    observedAt,
  };
}

function fitnessSummary(items) {
  const values = items.map((item) => item.fitness);
  return {
    mean: round(mean(values)),
    median: round(median(values)),
    min: values.length > 0 ? round(Math.min(...values)) : null,
    max: values.length > 0 ? round(Math.max(...values)) : null,
    unit: FITNESS_UNIT,
  };
}

function isolateGeneticFitnessOutliers(items, minGroupN) {
  const byGene = new Map();
  for (const item of items) {
    if (!byGene.has(item.geneKey)) byGene.set(item.geneKey, []);
    byGene.get(item.geneKey).push(item);
  }
  const included = [];
  const excluded = [];
  const auditByGene = [];
  for (const [geneKey, geneItems] of [...byGene.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const isolation = isolateLunaOutcomeOutliers(geneItems, { minGroupN });
    included.push(...isolation.included);
    excluded.push(...isolation.excluded);
    auditByGene.push({
      geneKey,
      rows: geneItems.length,
      excludedRows: isolation.audit.excludedRows,
      byOutcomeUnit: isolation.audit.byOutcomeUnit,
    });
  }
  return {
    included,
    excluded,
    audit: {
      method: 'gene_local_mad_modified_z_with_zero_mad_fallback',
      minGroupN,
      totalRows: items.length,
      includedRows: included.length,
      excludedRows: excluded.length,
      byGene: auditByGene,
    },
  };
}

function periodSplitGate(items, minGroupN, maxFitnessDrift) {
  const ordered = [...items].sort((left, right) => (
    left.observedAt - right.observedAt || compareIds(left.id, right.id)
  ));
  const periods = [];
  for (const item of ordered) {
    const period = item.observedAt.toISOString().slice(0, 10);
    const current = periods.at(-1);
    if (current?.period === period) current.items.push(item);
    else periods.push({ period, items: [item] });
  }
  let splitPeriodIndex = 0;
  let splitRowCount = 0;
  let closestDistance = Number.POSITIVE_INFINITY;
  let cumulativeRows = 0;
  for (let index = 1; index < periods.length; index += 1) {
    cumulativeRows += periods[index - 1].items.length;
    const distance = Math.abs(ordered.length / 2 - cumulativeRows);
    if (distance < closestDistance) {
      closestDistance = distance;
      splitPeriodIndex = index;
      splitRowCount = cumulativeRows;
    }
  }
  const first = ordered.slice(0, splitRowCount);
  const second = ordered.slice(splitRowCount);
  const minimumSplitN = Math.max(1, Math.ceil(minGroupN / 2));
  const firstMean = mean(first.map((item) => item.fitness));
  const secondMean = mean(second.map((item) => item.fitness));
  const absoluteDrift = firstMean == null || secondMean == null
    ? null
    : Math.abs(secondMean - firstMean);
  const sufficient = periods.length >= 2
    && items.length >= minGroupN
    && first.length >= minimumSplitN
    && second.length >= minimumSplitN;
  return {
    status: !sufficient ? 'insufficient' : absoluteDrift <= maxFitnessDrift ? 'pass' : 'fail',
    first: { n: first.length, meanFitness: round(firstMean) },
    second: { n: second.length, meanFitness: round(secondMean) },
    absoluteDrift: round(absoluteDrift),
    maxAllowedDrift: maxFitnessDrift,
    uniquePeriodN: periods.length,
    periodUnit: 'utc_date',
    splitBoundary: splitPeriodIndex > 0 ? periods[splitPeriodIndex].period : null,
    splitMethod: 'chronological_utc_date_buckets',
  };
}

function generationStabilityGate(items, minGroupN, maxFitnessDrift) {
  const byGeneration = new Map();
  for (const item of items) {
    if (!byGeneration.has(item.generation)) byGeneration.set(item.generation, []);
    byGeneration.get(item.generation).push(item.fitness);
  }
  const minimumGenerationN = Math.max(1, Math.ceil(minGroupN / 2));
  const generations = [...byGeneration.entries()]
    .map(([generation, values]) => ({
      generation,
      n: values.length,
      meanFitness: round(mean(values)),
    }))
    .sort((left, right) => left.generation - right.generation);
  const means = generations.map((row) => row.meanFitness);
  const range = means.length > 0 ? Math.max(...means) - Math.min(...means) : null;
  const sufficient = generations.length >= 2
    && generations.every((row) => row.n >= minimumGenerationN);
  return {
    status: !sufficient ? 'insufficient' : range <= maxFitnessDrift ? 'pass' : 'fail',
    generations,
    generationCount: generations.length,
    fitnessRange: round(range),
    maxAllowedRange: maxFitnessDrift,
    minimumGenerationN,
  };
}

function combineGateStatus(...statuses) {
  if (statuses.includes('fail')) return 'fail';
  if (statuses.includes('insufficient')) return 'insufficient';
  return statuses.length > 0 ? 'pass' : 'insufficient';
}

function costScenarioRows(rawFitness) {
  return GENETIC_COST_SCENARIOS.map((scenario) => {
    const roundTripCostFraction = 2
      * (scenario.feeBpsPerSide + scenario.slippageBpsPerSide)
      / 10_000;
    return {
      ...scenario,
      roundTripCostFraction: round(roundTripCostFraction),
      penalizedFitnessProxy: round(rawFitness - roundTripCostFraction),
      status: 'proxy_only_unit_mismatch',
      promotionEligible: false,
    };
  });
}

function flattenNumeric(value, prefix = '', output = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return output;
  for (const [key, nested] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const number = finiteOrNull(nested);
    if (number != null && typeof nested !== 'object') output[path] = number;
    else if (nested && typeof nested === 'object' && !Array.isArray(nested)) flattenNumeric(nested, path, output);
  }
  return output;
}

function chromosomeSetupFamily(chromosome) {
  return String(chromosome?.setupFamily || '').trim();
}

function semanticParameterMapping(chromosome, parameter) {
  const setupFamily = chromosomeSetupFamily(chromosome);
  return C17_PARAMETER_SEMANTIC_MAP[setupFamily]?.[parameter] || null;
}

function numericParameterRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({ ...row, numericValue: finiteOrNull(row.value) }))
    .filter((row) => row.numericValue != null);
}

function currentStoreMatch(chromosome, parameter, parameterRows) {
  const mapping = semanticParameterMapping(chromosome, parameter);
  if (!mapping) return { status: 'unavailable' };
  const matches = parameterRows.filter((row) => (
    row.key === mapping.storeKey
      && String(row.scope || 'global').trim().toLowerCase() === mapping.storeScope
  ));
  if (matches.length === 0) return { status: 'unavailable' };
  if (matches.length > 1) {
    return { status: 'ambiguous', keys: matches.map((row) => row.key).sort() };
  }
  return {
    status: 'matched',
    key: matches[0].key,
    scope: matches[0].scope || 'global',
    value: matches[0].numericValue,
    geneUnit: mapping.geneUnit,
    storeUnit: mapping.storeUnit,
    conversion: mapping.conversion,
  };
}

function currentStoreDistance(chromosome, parameterRows) {
  const parameters = [];
  let unavailableParameters = 0;
  let ambiguousParameters = 0;
  for (const [parameter, value] of Object.entries(flattenNumeric(chromosome))) {
    const mapping = semanticParameterMapping(chromosome, parameter);
    const currentStore = currentStoreMatch(chromosome, parameter, parameterRows);
    if (currentStore.status === 'unavailable') {
      unavailableParameters += 1;
      continue;
    }
    if (currentStore.status === 'ambiguous') {
      ambiguousParameters += 1;
      continue;
    }
    const geneValueInStoreUnit = mapping.toStoreValue(value);
    const absoluteDistance = Math.abs(geneValueInStoreUnit - currentStore.value);
    parameters.push({
      parameter,
      geneValue: value,
      geneValueInStoreUnit,
      geneUnit: currentStore.geneUnit,
      storeKey: currentStore.key,
      storeScope: currentStore.scope,
      currentValue: currentStore.value,
      storeUnit: currentStore.storeUnit,
      unitConversion: currentStore.conversion,
      absoluteDistance: round(absoluteDistance),
      normalizedDistance: round(absoluteDistance / Math.max(Math.abs(currentStore.value), 1e-12)),
    });
  }
  return {
    status: parameters.length === 0
      ? 'unavailable'
      : unavailableParameters > 0 || ambiguousParameters > 0 ? 'partial' : 'matched',
    matchedParameters: parameters.length,
    unavailableParameters,
    ambiguousParameters,
    parameters,
  };
}

function buildParameterDistribution(geneGroups, parameterRows) {
  const valuesByParameter = new Map();
  for (const group of geneGroups) {
    const setupFamily = chromosomeSetupFamily(group.chromosome);
    for (const [parameter, value] of Object.entries(flattenNumeric(group.chromosome))) {
      const key = `${setupFamily}\u0000${parameter}`;
      if (!valuesByParameter.has(key)) {
        valuesByParameter.set(key, { setupFamily, parameter, chromosome: group.chromosome, values: [] });
      }
      valuesByParameter.get(key).values.push(value);
    }
  }
  return [...valuesByParameter.values()]
    .map(({ setupFamily, parameter, chromosome, values }) => {
      const mapping = semanticParameterMapping(chromosome, parameter);
      const currentStore = currentStoreMatch(chromosome, parameter, parameterRows);
      const distances = currentStore.status === 'matched'
        ? values.map((value) => Math.abs(mapping.toStoreValue(value) - currentStore.value))
        : [];
      return {
        setupFamily,
        parameter,
        distinctGeneN: values.length,
        min: round(Math.min(...values)),
        max: round(Math.max(...values)),
        mean: round(mean(values)),
        median: round(median(values)),
        currentStore,
        meanAbsoluteDistance: distances.length > 0 ? round(mean(distances)) : null,
        distanceUnit: currentStore.status === 'matched' ? currentStore.storeUnit : null,
      };
    })
    .sort((left, right) => (
      left.setupFamily.localeCompare(right.setupFamily)
        || left.parameter.localeCompare(right.parameter)
    ));
}

function geneReport(group, rawItems, parameterRows, options) {
  const { minGroupN, maxFitnessDrift } = options;
  const periodSplit = periodSplitGate(group.items, minGroupN, maxFitnessDrift);
  const generationStability = generationStabilityGate(group.items, minGroupN, maxFitnessDrift);
  const status = group.items.length >= minGroupN ? 'sufficient' : 'insufficient';
  const overfitStatus = status === 'insufficient'
    ? 'insufficient'
    : combineGateStatus(periodSplit.status, generationStability.status);
  const fitness = fitnessSummary(group.items);
  return {
    geneKey: group.geneKey,
    chromosome: group.chromosome,
    rawN: rawItems.length,
    n: group.items.length,
    outlierExcludedN: rawItems.length - group.items.length,
    status,
    symbols: new Set(group.items.map((item) => item.symbol)).size,
    days: new Set(group.items.map((item) => item.observedAt.toISOString().slice(0, 10))).size,
    generations: new Set(group.items.map((item) => item.generation)).size,
    fitness,
    costAdjustedReevaluation: costScenarioRows(fitness.mean),
    overfitGate: {
      status: overfitStatus,
      periodSplit,
      generationStability,
    },
    currentStoreDistance: currentStoreDistance(group.chromosome, parameterRows),
  };
}

export function buildLunaPhase5GeneticReport(rows, currentParameters = [], options = {}) {
  const input = Array.isArray(rows) ? rows : [];
  const minGroupN = Math.max(1, Number(options.minGroupN) || DEFAULT_MIN_GROUP_N);
  const outlierMinGroupN = Math.max(3, Number(options.outlierMinGroupN) || minGroupN);
  const topLimit = Math.max(1, Number(options.topLimit) || DEFAULT_TOP_LIMIT);
  const maxFitnessDrift = Math.max(0, Number(options.maxFitnessDrift) || DEFAULT_MAX_FITNESS_DRIFT);
  const deduped = dedupeExactObservations(input);
  const invalidByReason = {
    missingSymbol: 0,
    invalidChromosome: 0,
    nonFiniteFitness: 0,
    unitMismatch: 0,
    outsideFitnessRange: 0,
    invalidGeneration: 0,
    invalidObservedAt: 0,
  };
  const valid = [];
  for (const row of deduped.rows) {
    const normalized = normalizeRow(row);
    if (normalized.invalidReason) invalidByReason[normalized.invalidReason] += 1;
    else valid.push(normalized);
  }
  const outlierIsolation = isolateGeneticFitnessOutliers(valid, outlierMinGroupN);
  const included = outlierIsolation.included;
  const rawByGene = new Map();
  const groups = new Map();
  for (const item of valid) {
    if (!rawByGene.has(item.geneKey)) rawByGene.set(item.geneKey, []);
    rawByGene.get(item.geneKey).push(item);
  }
  for (const item of included) {
    if (!groups.has(item.geneKey)) {
      groups.set(item.geneKey, {
        geneKey: item.geneKey,
        chromosome: item.chromosome,
        items: [],
      });
    }
    groups.get(item.geneKey).items.push(item);
  }
  const parameterRows = numericParameterRows(currentParameters);
  const geneGroups = [...groups.values()];
  const topGenes = geneGroups
    .map((group) => geneReport(group, rawByGene.get(group.geneKey) || [], parameterRows, {
      minGroupN,
      maxFitnessDrift,
    }))
    .sort((left, right) => (
      (right.status === 'sufficient' ? 1 : 0) - (left.status === 'sufficient' ? 1 : 0)
      || right.fitness.mean - left.fitness.mean
      || right.n - left.n
      || left.geneKey.localeCompare(right.geneKey)
    ))
    .slice(0, topLimit)
    .map((row, index) => ({ rank: index + 1, ...row }));
  const invalidRows = Object.values(invalidByReason).reduce((sum, count) => sum + count, 0);
  const gateStatuses = topGenes.map((gene) => gene.overfitGate.status);
  const costScenarios = GENETIC_COST_SCENARIOS.map((scenario) => ({
    ...scenario,
    roundTripCostFraction: round(2 * (scenario.feeBpsPerSide + scenario.slippageBpsPerSide) / 10_000),
    status: 'proxy_only_unit_mismatch',
    reason: 'fitness_score is a bounded policy score, not a realized return; subtraction is stress ranking only',
  }));
  const overfitStatus = combineGateStatus(...gateStatuses);
  const summary = `P5-C1 genetic report: ${included.length}/${input.length} valid deduped non-outlier observations, ${topGenes.length} top genes; cost reevaluation is proxy-only because fitness and return units differ; period split ${topGenes.filter((gene) => gene.overfitGate.periodSplit.status === 'pass').length} pass/${topGenes.length}, generation stability ${topGenes.filter((gene) => gene.overfitGate.generationStability.status === 'pass').length} pass/${topGenes.length}, overall ${overfitStatus}; sample gate n>=${minGroupN}.`;
  return {
    source: {
      requestedRelation: 'investment.luna_phase5_genetic_evolution',
      actualRelation: 'investment.luna_phase5_genetic_alpha_shadow',
      fallbackReason: 'requested relation is absent; the existing P5 genetic producer persists to the shadow relation',
      readOnly: true,
      fitnessUnit: FITNESS_UNIT,
    },
    audit: {
      rawRows: input.length,
      dedupedRows: deduped.rows.length,
      duplicateRows: deduped.duplicateRows,
      conflictingDuplicateKeys: deduped.conflictingDuplicateKeys,
      invalidRows,
      invalidByReason,
      validRows: valid.length,
      outlierExcludedRows: outlierIsolation.audit.excludedRows,
      evaluatedRows: included.length,
      outlierIsolation: outlierIsolation.audit,
      exactDuplicateKey: ['symbol', 'market', 'exchange', 'generation', 'chromosome', 'observed_at'],
      duplicateWinner: 'highest id',
    },
    costScenarios,
    overfitGate: {
      status: overfitStatus,
      evaluatedTopGenes: topGenes.length,
      periodSplitPassGenes: topGenes.filter((gene) => gene.overfitGate.periodSplit.status === 'pass').length,
      generationStabilityPassGenes: topGenes.filter((gene) => gene.overfitGate.generationStability.status === 'pass').length,
    },
    topGenes,
    parameterDistribution: buildParameterDistribution(geneGroups, parameterRows),
    sampleGate: {
      minGroupN,
      outlierMinGroupN,
      maxFitnessDrift,
      insufficientIsNotPromotionEligible: true,
    },
    summary,
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const valueOf = (name) => argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];
  return {
    json: argv.includes('--json'),
    limit: Math.max(0, Number(valueOf('limit') || 0) || 0),
    topLimit: Math.max(1, Number(valueOf('top') || DEFAULT_TOP_LIMIT) || DEFAULT_TOP_LIMIT),
    minGroupN: Math.max(1, Number(valueOf('min-group-n') || DEFAULT_MIN_GROUP_N) || DEFAULT_MIN_GROUP_N),
  };
}

export async function runLunaPhase5GeneticReport(options = parseArgs(), deps = {}) {
  const queryFn = deps.query || db.query;
  const rows = await queryFn(GENETIC_REPORT_SQL, [options.limit || 0]);
  const currentParameters = await queryFn(C17_PARAMETER_SQL);
  return buildLunaPhase5GeneticReport(rows, currentParameters, options);
}

async function main() {
  const options = parseArgs();
  const report = await runLunaPhase5GeneticReport(options);
  if (!options.json) console.log(report.summary);
  console.log(JSON.stringify(report, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna phase5 genetic report failed:',
  });
}
