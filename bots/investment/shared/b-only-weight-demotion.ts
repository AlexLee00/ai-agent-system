// @ts-nocheck

import fs from 'node:fs';
import { investmentOpsRuntimeFile } from './runtime-ops-path.ts';

const DAY_MS = 86_400_000;
const ENABLED_VALUES = new Set(['1', 'true', 'on', 'enabled']);

export const B_ONLY_WEIGHT_DEMOTION_PROPOSAL_FILE = investmentOpsRuntimeFile(
  'luna-b-only-weight-demotion-proposal.json',
);

export const B_ONLY_WEIGHT_DEMOTION_DEFAULTS = Object.freeze({
  lookbackDays: 180,
  horizonDays: 20,
  roundTripCostPct: 0.30,
  minSamples: 40,
  minSpanDays: 120,
  minTwentyDayBlocks: 6,
  minAnchorSamples: 200,
  minAnchorSymbols: 10,
  winsorTailRate: 0.05,
  maxEvidenceAgeDays: 8,
  moderate: Object.freeze({ maxWinDeltaPct: -15, maxMeanDeltaPct: -5, weight: 0.75 }),
  severe: Object.freeze({ maxWinDeltaPct: -25, maxMeanDeltaPct: -10, weight: 0.50 }),
});

function finiteNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 6) {
  const number = finiteNumber(value, null);
  return number == null ? null : Number(number.toFixed(digits));
}

export function normalizeBOnlySymbol(value) {
  const raw = String(value || '').trim().toUpperCase().replace('-', '/');
  if (!raw) return '';
  if (raw.includes('/')) return raw;
  return raw.endsWith('USDT') ? `${raw.slice(0, -4)}/USDT` : raw;
}

function timestampMs(value) {
  if (value instanceof Date) return value.getTime();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function winsorizedMean(values, tailRate) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const tail = Math.floor(sorted.length * tailRate);
  const low = sorted[Math.min(tail, sorted.length - 1)];
  const high = sorted[Math.max(0, sorted.length - 1 - tail)];
  return mean(sorted.map((value) => Math.max(low, Math.min(high, value))));
}

function normalizeConfig(config = {}) {
  return {
    ...B_ONLY_WEIGHT_DEMOTION_DEFAULTS,
    ...config,
    moderate: { ...B_ONLY_WEIGHT_DEMOTION_DEFAULTS.moderate, ...(config.moderate || {}) },
    severe: { ...B_ONLY_WEIGHT_DEMOTION_DEFAULTS.severe, ...(config.severe || {}) },
  };
}

function sameFiniteNumber(left, right) {
  const normalizedLeft = finiteNumber(left, null);
  const normalizedRight = finiteNumber(right, null);
  return normalizedLeft != null && normalizedLeft === normalizedRight;
}

function closeFiniteNumber(left, right, tolerance = 0.0001) {
  const normalizedLeft = finiteNumber(left, null);
  const normalizedRight = finiteNumber(right, null);
  return normalizedLeft != null
    && normalizedRight != null
    && Math.abs(normalizedLeft - normalizedRight) <= tolerance;
}

function stageConfigMatches(actual, expected) {
  return actual && typeof actual === 'object'
    && sameFiniteNumber(actual.maxWinDeltaPct, expected.maxWinDeltaPct)
    && sameFiniteNumber(actual.maxMeanDeltaPct, expected.maxMeanDeltaPct)
    && sameFiniteNumber(actual.weight, expected.weight);
}

export function isBOnlyWeightDemotionProposalValid(proposal) {
  if (!proposal || typeof proposal !== 'object' || Array.isArray(proposal)) return false;
  if (
    proposal.schemaVersion !== 1
    || proposal.status !== 'b_only_weight_demotion_proposal_ready'
    || proposal.proposalOnly !== true
    || proposal.autoApply !== false
    || proposal.liveMutation !== false
  ) return false;
  const methodology = proposal.methodology;
  if (
    methodology?.metric !== 'd20_return_percent_points_net_of_round_trip_cost'
    || JSON.stringify(methodology?.layers) !== JSON.stringify(['virtual', 'real_entry_mark_to_market'])
    || methodology?.anchor !== 'D_leave_one_symbol_out'
    || methodology?.reevaluation !== 'weekly_after_major20_drift'
    || methodology?.psrRole !== 'admission_only'
    || methodology?.sizingRole !== 'b_only_weight_only'
    || methodology?.guardComposition !== 'b_only_then_minimum_absolute_cap'
  ) return false;

  const config = proposal.config;
  const scalarConfigKeys = [
    'lookbackDays',
    'horizonDays',
    'roundTripCostPct',
    'minSamples',
    'minSpanDays',
    'minTwentyDayBlocks',
    'minAnchorSamples',
    'minAnchorSymbols',
    'winsorTailRate',
    'maxEvidenceAgeDays',
  ];
  if (!config || !scalarConfigKeys.every((key) => sameFiniteNumber(
    config[key],
    B_ONLY_WEIGHT_DEMOTION_DEFAULTS[key],
  ))) return false;
  if (
    !stageConfigMatches(config.moderate, B_ONLY_WEIGHT_DEMOTION_DEFAULTS.moderate)
    || !stageConfigMatches(config.severe, B_ONLY_WEIGHT_DEMOTION_DEFAULTS.severe)
  ) return false;

  const groups = proposal.groups;
  if (!groups || !['B', 'C', 'D'].every((name) => Array.isArray(groups[name]))) return false;
  const normalizedGroups = Object.fromEntries(['B', 'C', 'D'].map((name) => [
    name,
    groups[name].map(normalizeBOnlySymbol).filter(Boolean),
  ]));
  if (
    normalizedGroups.B.length !== 20
    || normalizedGroups.C.length !== 10
    || normalizedGroups.D.length < 10
    || ['B', 'C', 'D'].some((name) => new Set(normalizedGroups[name]).size !== normalizedGroups[name].length)
  ) return false;
  const bSet = new Set(normalizedGroups.B);
  if (!normalizedGroups.C.every((symbol) => bSet.has(symbol))) return false;
  if (!normalizedGroups.D.every((symbol) => bSet.has(symbol))) return false;
  if (!proposal.symbols || typeof proposal.symbols !== 'object' || Array.isArray(proposal.symbols)) return false;
  return timestampMs(proposal.windowEndAt) != null;
}

function isEligibleProposalRecord({ proposal, record, symbol }) {
  if (!record || typeof record !== 'object' || record.eligible !== true || record.bOnly !== true) return false;
  if (normalizeBOnlySymbol(record.symbol) !== symbol) return false;
  const bSet = new Set(proposal.groups.B.map(normalizeBOnlySymbol));
  const cSet = new Set(proposal.groups.C.map(normalizeBOnlySymbol));
  if (!bSet.has(symbol) || cSet.has(symbol)) return false;
  if (!Array.isArray(record.reasons) || record.reasons.length > 0) return false;

  const config = proposal.config;
  const sampleSize = finiteNumber(record.sampleSize, null);
  const realSamples = finiteNumber(record.realSamples, null);
  const virtualSamples = finiteNumber(record.virtualSamples, null);
  const wins = finiteNumber(record.wins, null);
  const winRatePct = finiteNumber(record.winRatePct, null);
  const meanPct = finiteNumber(record.meanPct, null);
  const winsorizedMeanPct = finiteNumber(record.winsorizedMeanPct, null);
  const spanDays = finiteNumber(record.spanDays, null);
  const blocks = finiteNumber(record.twentyDayBlocks, null);
  const anchorSamples = finiteNumber(record.anchor?.sampleSize, null);
  const anchorRealSamples = finiteNumber(record.anchor?.realSamples, null);
  const anchorVirtualSamples = finiteNumber(record.anchor?.virtualSamples, null);
  const anchorWins = finiteNumber(record.anchor?.wins, null);
  const anchorWinRatePct = finiteNumber(record.anchor?.winRatePct, null);
  const anchorMeanPct = finiteNumber(record.anchor?.meanPct, null);
  const anchorWinsorizedMeanPct = finiteNumber(record.anchor?.winsorizedMeanPct, null);
  const anchorSymbols = finiteNumber(record.anchor?.distinctSymbols, null);
  if (
    !Number.isInteger(sampleSize)
    || !Number.isInteger(realSamples)
    || !Number.isInteger(virtualSamples)
    || sampleSize < config.minSamples
    || realSamples < 0
    || virtualSamples < 0
    || realSamples + virtualSamples !== sampleSize
    || !Number.isInteger(wins)
    || wins < 0
    || wins > sampleSize
    || !closeFiniteNumber(winRatePct, wins / sampleSize * 100)
    || meanPct == null
    || winsorizedMeanPct == null
    || spanDays == null
    || spanDays < config.minSpanDays
    || !Number.isInteger(blocks)
    || blocks < config.minTwentyDayBlocks
    || !Number.isInteger(anchorSamples)
    || anchorSamples < config.minAnchorSamples
    || !Number.isInteger(anchorRealSamples)
    || !Number.isInteger(anchorVirtualSamples)
    || anchorRealSamples < 0
    || anchorVirtualSamples < 0
    || anchorRealSamples + anchorVirtualSamples !== anchorSamples
    || !Number.isInteger(anchorWins)
    || anchorWins < 0
    || anchorWins > anchorSamples
    || !closeFiniteNumber(anchorWinRatePct, anchorWins / anchorSamples * 100)
    || anchorMeanPct == null
    || anchorWinsorizedMeanPct == null
    || !Number.isInteger(anchorSymbols)
    || anchorSymbols < config.minAnchorSymbols
  ) return false;

  const suppliedDeltas = {
    winDeltaPct: finiteNumber(record.deltas?.winDeltaPct, null),
    meanDeltaPct: finiteNumber(record.deltas?.meanDeltaPct, null),
    winsorizedMeanDeltaPct: finiteNumber(record.deltas?.winsorizedMeanDeltaPct, null),
  };
  if (Object.values(suppliedDeltas).some((value) => value == null)) return false;
  const recomputedDeltas = {
    winDeltaPct: winRatePct - anchorWinRatePct,
    meanDeltaPct: meanPct - anchorMeanPct,
    winsorizedMeanDeltaPct: winsorizedMeanPct - anchorWinsorizedMeanPct,
  };
  if (!Object.keys(recomputedDeltas).every((key) => closeFiniteNumber(
    suppliedDeltas[key],
    recomputedDeltas[key],
  ))) return false;
  const derived = stageForDeltas(recomputedDeltas, config);
  return record.stage === derived.stage
    && sameFiniteNumber(record.recommendedWeight, derived.weight);
}

function normalizeObservation(event, fallbackSource, windowStartMs, maturityCutoffMs) {
  const symbol = normalizeBOnlySymbol(event?.symbol);
  const observedAtMs = timestampMs(event?.observedAt ?? event?.firedAt ?? event?.entryTime ?? event?.entry_time);
  const d20NetPct = finiteNumber(event?.d20NetPct ?? event?.d20_net_pct, null);
  if (!symbol || observedAtMs == null || d20NetPct == null) return null;
  if (observedAtMs < windowStartMs || observedAtMs > maturityCutoffMs) return null;
  return {
    symbol,
    observedAt: new Date(observedAtMs).toISOString(),
    observedAtMs,
    d20NetPct,
    source: event?.source === 'real' ? 'real' : fallbackSource,
  };
}

function summarizeObservations(events, { windowStartMs, config }) {
  const values = events.map((event) => event.d20NetPct);
  const timestamps = events.map((event) => event.observedAtMs).sort((left, right) => left - right);
  const blocks = new Set(timestamps.map((value) => Math.floor((value - windowStartMs) / (config.horizonDays * DAY_MS))));
  const startAt = timestamps.length ? timestamps[0] : null;
  const endAt = timestamps.length ? timestamps.at(-1) : null;
  return {
    sampleSize: events.length,
    realSamples: events.filter((event) => event.source === 'real').length,
    virtualSamples: events.filter((event) => event.source !== 'real').length,
    wins: values.filter((value) => value > 0).length,
    winRatePct: values.length ? values.filter((value) => value > 0).length / values.length * 100 : null,
    meanPct: mean(values),
    winsorizedMeanPct: winsorizedMean(values, config.winsorTailRate),
    spanDays: startAt == null || endAt == null ? 0 : (endAt - startAt) / DAY_MS,
    twentyDayBlocks: blocks.size,
    startAt: startAt == null ? null : new Date(startAt).toISOString(),
    endAt: endAt == null ? null : new Date(endAt).toISOString(),
  };
}

function stageForDeltas({ winDeltaPct, meanDeltaPct, winsorizedMeanDeltaPct }, config) {
  if (
    winDeltaPct <= config.severe.maxWinDeltaPct
    && meanDeltaPct <= config.severe.maxMeanDeltaPct
    && winsorizedMeanDeltaPct <= config.severe.maxMeanDeltaPct
  ) {
    return { stage: 'severe', weight: config.severe.weight };
  }
  if (
    winDeltaPct <= config.moderate.maxWinDeltaPct
    && meanDeltaPct <= config.moderate.maxMeanDeltaPct
    && winsorizedMeanDeltaPct <= config.moderate.maxMeanDeltaPct
  ) {
    return { stage: 'moderate', weight: config.moderate.weight };
  }
  return { stage: 'neutral', weight: 1 };
}

export function buildBOnlyWeightDemotionProposal({
  groups = {},
  virtualEvents = [],
  realEvents = [],
  generatedAt = new Date().toISOString(),
  windowEndAt = generatedAt,
  config: configOverrides = {},
} = {}) {
  const config = normalizeConfig(configOverrides);
  const windowEndMs = timestampMs(windowEndAt) ?? Date.now();
  const windowStartMs = windowEndMs - config.lookbackDays * DAY_MS;
  const maturityCutoffMs = windowEndMs - config.horizonDays * DAY_MS;
  const normalizedGroups = Object.fromEntries(['B', 'C', 'D'].map((name) => [
    name,
    [...new Set((groups[name] || []).map(normalizeBOnlySymbol).filter(Boolean))],
  ]));
  const observations = [
    ...(virtualEvents || []).map((event) => normalizeObservation(event, 'virtual', windowStartMs, maturityCutoffMs)),
    ...(realEvents || []).map((event) => normalizeObservation(event, 'real', windowStartMs, maturityCutoffMs)),
  ].filter(Boolean);
  const cSet = new Set(normalizedGroups.C);
  const dSet = new Set(normalizedGroups.D);
  const dObservations = observations.filter((event) => dSet.has(event.symbol));
  const symbols = {};

  for (const symbol of normalizedGroups.B) {
    const bOnly = !cSet.has(symbol);
    const symbolEvents = observations.filter((event) => event.symbol === symbol);
    const anchorEvents = dObservations.filter((event) => event.symbol !== symbol);
    const stats = summarizeObservations(symbolEvents, { windowStartMs, config });
    const anchor = summarizeObservations(anchorEvents, { windowStartMs, config });
    const anchorSymbols = new Set(anchorEvents.map((event) => event.symbol)).size;
    const reasons = [];
    if (!bOnly) reasons.push('not_b_only');
    if (stats.sampleSize < config.minSamples) reasons.push('sample_below_minimum');
    if (stats.spanDays < config.minSpanDays) reasons.push('span_below_minimum');
    if (stats.twentyDayBlocks < config.minTwentyDayBlocks) reasons.push('blocks_below_minimum');
    if (anchor.sampleSize < config.minAnchorSamples) reasons.push('anchor_sample_below_minimum');
    if (anchorSymbols < config.minAnchorSymbols) reasons.push('anchor_symbols_below_minimum');

    const eligible = reasons.length === 0;
    const deltas = eligible ? {
      winDeltaPct: stats.winRatePct - anchor.winRatePct,
      meanDeltaPct: stats.meanPct - anchor.meanPct,
      winsorizedMeanDeltaPct: stats.winsorizedMeanPct - anchor.winsorizedMeanPct,
    } : {
      winDeltaPct: null,
      meanDeltaPct: null,
      winsorizedMeanDeltaPct: null,
    };
    const stage = eligible ? stageForDeltas(deltas, config) : { stage: 'neutral', weight: 1 };
    symbols[symbol] = {
      symbol,
      bOnly,
      eligible,
      stage: stage.stage,
      recommendedWeight: stage.weight,
      reasons,
      ...stats,
      anchor: { ...anchor, distinctSymbols: anchorSymbols },
      deltas: Object.fromEntries(Object.entries(deltas).map(([key, value]) => [key, round(value, 6)])),
      winRatePct: round(stats.winRatePct, 6),
      meanPct: round(stats.meanPct, 6),
      winsorizedMeanPct: round(stats.winsorizedMeanPct, 6),
    };
  }

  return {
    schemaVersion: 1,
    status: 'b_only_weight_demotion_proposal_ready',
    generatedAt: new Date(timestampMs(generatedAt) ?? Date.now()).toISOString(),
    windowEndAt: new Date(windowEndMs).toISOString(),
    windowStartAt: new Date(windowStartMs).toISOString(),
    proposalOnly: true,
    autoApply: false,
    liveMutation: false,
    methodology: {
      metric: 'd20_return_percent_points_net_of_round_trip_cost',
      layers: ['virtual', 'real_entry_mark_to_market'],
      anchor: 'D_leave_one_symbol_out',
      reevaluation: 'weekly_after_major20_drift',
      psrRole: 'admission_only',
      sizingRole: 'b_only_weight_only',
      guardComposition: 'b_only_then_minimum_absolute_cap',
    },
    config,
    groups: normalizedGroups,
    sourceCounts: {
      virtual: observations.filter((event) => event.source !== 'real').length,
      real: observations.filter((event) => event.source === 'real').length,
      combined: observations.length,
    },
    symbols,
  };
}

export function isBOnlyWeightDemotionEnabled(env = process.env) {
  return ENABLED_VALUES.has(String(env?.LUNA_BONLY_WEIGHT_DEMOTION_ENABLED || '').trim().toLowerCase());
}

export function resolveBOnlyWeightDemotion(input = {}, env = process.env) {
  const symbol = normalizeBOnlySymbol(input.symbol);
  const downstreamAmountUsdt = Math.max(0, finiteNumber(input.downstreamAmountUsdt, 0));
  const minOrderUsdt = Math.max(0, finiteNumber(input.minOrderUsdt, 0));
  const proposal = input.proposal && typeof input.proposal === 'object' ? input.proposal : null;
  const record = proposal?.symbols?.[symbol] || null;
  const proposalValid = isBOnlyWeightDemotionProposalValid(proposal);
  const maxEvidenceAgeDays = proposalValid
    ? finiteNumber(proposal.config.maxEvidenceAgeDays, B_ONLY_WEIGHT_DEMOTION_DEFAULTS.maxEvidenceAgeDays)
    : B_ONLY_WEIGHT_DEMOTION_DEFAULTS.maxEvidenceAgeDays;
  const evidenceAtMs = timestampMs(proposal?.windowEndAt);
  const nowMs = timestampMs(input.now) ?? Date.now();
  const evidenceAgeMs = evidenceAtMs == null ? null : nowMs - evidenceAtMs;
  const fresh = evidenceAgeMs != null
    && evidenceAgeMs >= -DAY_MS
    && evidenceAgeMs <= maxEvidenceAgeDays * DAY_MS;
  const weight = finiteNumber(record?.recommendedWeight, 1);
  const evidenceEligible = proposalValid
    && fresh
    && [0.5, 0.75, 1].includes(weight)
    && isEligibleProposalRecord({ proposal, record, symbol });
  const recommendedWeight = evidenceEligible ? weight : 1;
  const enabled = isBOnlyWeightDemotionEnabled(env);
  const appliedWeight = enabled ? recommendedWeight : 1;
  const counterfactualAmountUsdt = round(downstreamAmountUsdt * recommendedWeight, 8);
  const appliedAmountUsdt = round(downstreamAmountUsdt * appliedWeight, 8);

  return {
    enabled,
    symbol,
    proposalAvailable: proposal != null,
    proposalValid,
    evidenceEligible,
    fresh,
    evidenceAgeDays: evidenceAgeMs == null ? null : round(evidenceAgeMs / DAY_MS, 4),
    recommendedWeight,
    appliedWeight,
    downstreamAmountUsdt,
    minOrderUsdt,
    counterfactualAmountUsdt,
    appliedAmountUsdt,
    wouldReduce: counterfactualAmountUsdt < downstreamAmountUsdt,
    applied: enabled && appliedAmountUsdt < downstreamAmountUsdt,
    wouldRejectBelowMinimum: recommendedWeight < 1 && counterfactualAmountUsdt < minOrderUsdt,
    stage: evidenceEligible ? record.stage : 'neutral',
    sampleSize: evidenceEligible ? record.sampleSize : 0,
    realSamples: evidenceEligible ? record.realSamples : 0,
    virtualSamples: evidenceEligible ? record.virtualSamples : 0,
    psrRole: 'admission_only',
    combineOrder: 'responsibility_then_b_only_then_guard_min_absolute_cap',
    liveMutation: enabled && appliedAmountUsdt !== downstreamAmountUsdt,
  };
}

let proposalCache = null;

export function loadBOnlyWeightDemotionProposal({ filePath = B_ONLY_WEIGHT_DEMOTION_PROPOSAL_FILE } = {}) {
  try {
    const stat = fs.statSync(filePath);
    if (proposalCache?.filePath === filePath && proposalCache.mtimeMs === stat.mtimeMs) {
      return proposalCache.proposal;
    }
    const proposal = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    proposalCache = { filePath, mtimeMs: stat.mtimeMs, proposal };
    return proposal;
  } catch {
    return null;
  }
}

export default {
  B_ONLY_WEIGHT_DEMOTION_DEFAULTS,
  B_ONLY_WEIGHT_DEMOTION_PROPOSAL_FILE,
  buildBOnlyWeightDemotionProposal,
  isBOnlyWeightDemotionEnabled,
  isBOnlyWeightDemotionProposalValid,
  loadBOnlyWeightDemotionProposal,
  normalizeBOnlySymbol,
  resolveBOnlyWeightDemotion,
};
