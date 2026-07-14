// @ts-nocheck

import { isAnalystPredictionCorrect } from './analyst-prediction-correctness.ts';

const MAX_REFLECTION_SENTENCES = 3;
const REFLECTION_DEDUPE_SIMILARITY = 0.8;
const OUTLIER_MIN_GROUP_N = 5;
const OUTLIER_MODIFIED_Z_THRESHOLD = 3.5;
const OUTLIER_ZERO_MAD_RELATIVE_MULTIPLIER = 10;
const OUTLIER_ZERO_MAD_ABSOLUTE_FLOOR = 1;

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizeLunaMarketKey(value) {
  const market = String(value || '').trim().toLowerCase();
  if (['crypto', 'binance'].includes(market)) return 'crypto';
  if (['domestic', 'stocks', 'stock', 'kis', 'krx'].includes(market)) return 'domestic';
  if (['overseas', 'kis_overseas'].includes(market)) return 'overseas';
  return market || 'unknown';
}

export function resolveLunaAnalystCallAccuracy(call = {}, payload = {}) {
  if (typeof call.accurate === 'boolean') return call.accurate;
  return isAnalystPredictionCorrect(
    call.prediction,
    payload.side,
    Number(payload.pnlPct) > 0,
  );
}

function normalizeTradeSide(value) {
  const side = String(value || '').trim().toLowerCase();
  if (['buy', 'long'].includes(side)) return 'buy';
  if (['sell', 'short'].includes(side)) return 'sell';
  return side || 'unknown_side';
}

function splitReflectionSentences(value) {
  const sentences = [];
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1] || '';
    const next = value[index + 1] || '';
    const decimalPoint = char === '.' && /\d/.test(previous) && /\d/.test(next);
    const terminal = ['.', '!', '?'].includes(char) && !decimalPoint;
    if (!terminal || ['.', '!', '?'].includes(next)) continue;
    const sentence = value.slice(start, index + 1).trim();
    if (sentence) sentences.push(sentence);
    start = index + 1;
  }
  const trailing = value.slice(start).trim();
  if (trailing) sentences.push(trailing);
  return sentences;
}

export function normalizeLunaReflectionText(value) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  return splitReflectionSentences(compact)
    .slice(0, MAX_REFLECTION_SENTENCES)
    .map((sentence) => /[.!?]$/.test(sentence) ? sentence : `${sentence}.`)
    .join(' ');
}

export function buildLunaReflectionDedupeReason(payload = {}) {
  const profitable = Number(payload.pnlPct) > 0;
  const analystSummary = (payload.analystCalls || [])
    .map((call) => {
      const prediction = String(call.prediction || '').trim().toLowerCase();
      const predictionCorrect = resolveLunaAnalystCallAccuracy(call, payload);
      const correct = predictionCorrect == null ? 'unscored' : predictionCorrect ? 'correct' : 'incorrect';
      return `${String(call.botName || 'unknown').toLowerCase()}:${prediction || 'unknown'}:${correct}`;
    })
    .join(' ');
  return [
    payload.regime || 'unknown_regime',
    payload.strategyProfile || 'unknown_setup',
    `side/${normalizeTradeSide(payload.side)}`,
    profitable ? 'profitable' : 'unprofitable',
    analystSummary || 'no_analyst_calls',
  ].join(' ');
}

function reflectionReasonTokens(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/_-]+/gu, ' ')
    .split(/\s+/)
    .map((token) => token.replace(/(에서|으로|에게|부터|까지|보다|처럼|하고|이며|이고|은|는|이|가|을|를|과|와)$/u, ''))
    .filter(Boolean);
}

export function lunaReflectionReasonSimilarity(left, right) {
  const leftSet = new Set(reflectionReasonTokens(left));
  const rightSet = new Set(reflectionReasonTokens(right));
  if (leftSet.size === 0 || rightSet.size === 0) return 0;
  const intersection = [...leftSet].filter((token) => rightSet.has(token)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return union > 0 ? intersection / union : 0;
}

export function isLunaReflectionDuplicateReason(left, right) {
  const leftSide = reflectionReasonTokens(left).find((token) => token.startsWith('side/'));
  const rightSide = reflectionReasonTokens(right).find((token) => token.startsWith('side/'));
  if (!leftSide || !rightSide || leftSide !== rightSide) return false;
  return lunaReflectionReasonSimilarity(left, right) >= REFLECTION_DEDUPE_SIMILARITY;
}

export function buildLunaOutcomeSelectionSql(candidateSql) {
  const normalizedCandidateSql = String(candidateSql || '').trim().replace(/;+\s*$/, '');
  if (!normalizedCandidateSql) throw new Error('candidate SQL is required');
  return `
    WITH outcome_candidates AS (
      ${normalizedCandidateSql}
    ), preferred_candidates AS (
      SELECT candidate.*
        FROM outcome_candidates candidate
       WHERE candidate.priority = (SELECT MIN(priority) FROM outcome_candidates)
    ), preferred_count AS (
      SELECT COUNT(*)::integer AS candidate_count
        FROM preferred_candidates
    )
    SELECT CASE WHEN count.candidate_count = 1 THEN candidate.outcome_source END AS outcome_source,
           CASE WHEN count.candidate_count = 1 THEN candidate.actual_action_type END AS actual_action_type,
           CASE WHEN count.candidate_count = 1 THEN candidate.actual_action_size_pct END AS actual_action_size_pct,
           CASE WHEN count.candidate_count = 1 THEN candidate.realized_reward END AS realized_reward,
           CASE WHEN count.candidate_count = 1 THEN candidate.outcome_unit END AS outcome_unit,
           CASE WHEN count.candidate_count = 1 THEN candidate.is_paper END AS is_paper,
           CASE
             WHEN count.candidate_count = 1 THEN 'matched'
             ELSE 'ambiguous_key_excluded'
           END AS outcome_status,
           count.candidate_count AS outcome_candidate_count
      FROM preferred_count count
      LEFT JOIN LATERAL (
        SELECT preferred.*
          FROM preferred_candidates preferred
         ORDER BY preferred.candidate_key
         LIMIT 1
      ) candidate ON TRUE
     WHERE count.candidate_count > 0
  `;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function outcomeUnitOf(row) {
  const unit = String(row?.outcomeUnit ?? row?.outcome_unit ?? '').trim().toLowerCase();
  return unit || 'unknown';
}

function realizedRewardOf(row) {
  return finiteNumber(row?.realizedReward ?? row?.realized_reward);
}

export function isolateLunaOutcomeOutliers(rows = [], options = {}) {
  const input = Array.isArray(rows) ? rows : [];
  const minGroupN = Math.max(3, Number(options.minGroupN) || OUTLIER_MIN_GROUP_N);
  const threshold = Math.max(1, Number(options.modifiedZThreshold) || OUTLIER_MODIFIED_Z_THRESHOLD);
  const groups = new Map();
  for (const row of input) {
    const value = realizedRewardOf(row);
    if (value == null) continue;
    const unit = outcomeUnitOf(row);
    if (!groups.has(unit)) groups.set(unit, []);
    groups.get(unit).push({ row, value });
  }

  const excludedRows = new Set();
  const byOutcomeUnit = [];
  for (const [outcomeUnit, entries] of groups.entries()) {
    const center = median(entries.map((entry) => entry.value));
    const mad = median(entries.map((entry) => Math.abs(entry.value - center)));
    const zeroMadThreshold = Math.max(
      Math.abs(center) * OUTLIER_ZERO_MAD_RELATIVE_MULTIPLIER,
      OUTLIER_ZERO_MAD_ABSOLUTE_FLOOR,
    );
    let excluded = 0;
    if (entries.length >= minGroupN) {
      for (const entry of entries) {
        const absoluteDeviation = Math.abs(entry.value - center);
        const isOutlier = mad > 0
          ? 0.6745 * absoluteDeviation / mad > threshold
          : absoluteDeviation > zeroMadThreshold;
        if (isOutlier) {
          excludedRows.add(entry.row);
          excluded += 1;
        }
      }
    }
    byOutcomeUnit.push({
      outcomeUnit,
      rows: entries.length,
      median: center,
      mad,
      zeroMadThreshold: mad === 0 ? zeroMadThreshold : null,
      excludedRows: excluded,
    });
  }
  byOutcomeUnit.sort((left, right) => left.outcomeUnit.localeCompare(right.outcomeUnit));

  const excluded = input.filter((row) => excludedRows.has(row));
  const included = input.filter((row) => !excludedRows.has(row));
  const eligibleRows = [...groups.values()].reduce((sum, entries) => sum + entries.length, 0);
  return {
    included,
    excluded,
    audit: {
      method: 'mad_modified_z_with_zero_mad_fallback',
      modifiedZThreshold: threshold,
      zeroMadRelativeMultiplier: OUTLIER_ZERO_MAD_RELATIVE_MULTIPLIER,
      zeroMadAbsoluteFloor: OUTLIER_ZERO_MAD_ABSOLUTE_FLOOR,
      minGroupN,
      totalRows: input.length,
      eligibleRows,
      includedRows: eligibleRows - excluded.length,
      excludedRows: excluded.length,
      byOutcomeUnit,
    },
  };
}

export default {
  buildLunaOutcomeSelectionSql,
  buildLunaReflectionDedupeReason,
  isLunaReflectionDuplicateReason,
  isolateLunaOutcomeOutliers,
  lunaReflectionReasonSimilarity,
  normalizeLunaMarketKey,
  normalizeLunaReflectionText,
  resolveLunaAnalystCallAccuracy,
};
