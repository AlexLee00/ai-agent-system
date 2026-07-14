#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db/core.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLunaOutcomeSelectionSql,
  isolateLunaOutcomeOutliers,
} from '../shared/luna-data-contracts.ts';

const DEFAULT_MIN_GROUP_N = 30;

export function buildMatchedTradeOutcomesSql(tradesTable = 'investment.trades') {
  const table = String(tradesTable || '');
  if (!/^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*$/i.test(table)) {
    throw new Error(`invalid trades table: ${table}`);
  }
  return `
    SELECT entry_trade.id::text AS entry_trade_id,
           COALESCE(matched_sell.id::text, entry_trade.id::text) AS outcome_trade_id,
           entry_trade.signal_id::text AS signal_id,
           entry_trade.symbol,
           entry_trade.executed_at,
           CASE
             WHEN LOWER(entry_trade.side) IN ('buy', 'long') THEN 'buy'
             WHEN LOWER(entry_trade.side) IN ('sell', 'short') THEN 'sell'
             ELSE LOWER(entry_trade.side)
           END AS actual_action_type,
           -- investment.trades stores fractional returns: 0.05 means +5%.
           CASE
             WHEN LOWER(entry_trade.side) IN ('buy', 'long')
               THEN CASE
                 WHEN matched_sell.has_multi_lot OR matched_sell.has_incomplete_close THEN NULL
                 ELSE matched_sell.realized_pnl_pct
               END
             ELSE entry_trade.realized_pnl_pct::double precision
           END AS realized_reward,
           'return_fraction'::text AS outcome_unit,
           CASE
             WHEN LOWER(entry_trade.side) IN ('buy', 'long') AND matched_sell.has_multi_lot
               THEN 'multi_lot_excluded'
             WHEN LOWER(entry_trade.side) IN ('buy', 'long') AND matched_sell.has_incomplete_close
               THEN 'partial_close_excluded'
             ELSE 'matched'
           END AS outcome_status,
           COALESCE(matched_sell.paper, entry_trade.paper) AS is_paper
      FROM ${table} entry_trade
      LEFT JOIN LATERAL (
        SELECT STRING_AGG(close_trade.id::text, ',' ORDER BY close_trade.executed_at, close_trade.id) AS id,
               COALESCE(
                 SUM(close_trade.realized_pnl_pct::double precision * ABS(close_trade.amount::double precision))
                   / NULLIF(SUM(ABS(close_trade.amount::double precision)), 0),
                 AVG(close_trade.realized_pnl_pct::double precision)
               ) AS realized_pnl_pct,
               BOOL_OR(close_trade.cumulative_close_amount > COALESCE(ABS(entry_trade.amount::double precision), 0) + 1e-12) AS has_multi_lot,
               COALESCE(SUM(ABS(close_trade.amount::double precision)), 0) + 1e-12
                 < COALESCE(ABS(entry_trade.amount::double precision), 0) AS has_incomplete_close,
               BOOL_AND(close_trade.paper) AS paper
          FROM (
            SELECT raw_close_trade.*,
                   SUM(COALESCE(ABS(raw_close_trade.amount::double precision), 0)) OVER (
                     ORDER BY raw_close_trade.executed_at, raw_close_trade.id
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                   ) AS cumulative_close_amount
              FROM ${table} raw_close_trade
             WHERE LOWER(raw_close_trade.side) IN ('sell', 'short')
               AND raw_close_trade.matched_buy_id::text = entry_trade.id::text
               AND raw_close_trade.symbol = entry_trade.symbol
               AND raw_close_trade.exchange IS NOT DISTINCT FROM entry_trade.exchange
               AND raw_close_trade.executed_at >= entry_trade.executed_at
               AND raw_close_trade.realized_pnl_pct IS NOT NULL
          ) close_trade
         WHERE LOWER(entry_trade.side) IN ('buy', 'long')
      ) matched_sell ON TRUE
     WHERE (LOWER(entry_trade.side) IN ('buy', 'long') AND matched_sell.id IS NOT NULL)
        OR (LOWER(entry_trade.side) NOT IN ('buy', 'long') AND entry_trade.realized_pnl_pct IS NOT NULL)
  `;
}

const RL_OUTCOME_CANDIDATE_SQL = `
  SELECT tj.id::text AS candidate_key,
         1 AS priority,
         'trade_journal'::text AS outcome_source,
         CASE
           WHEN LOWER(tj.direction) IN ('buy', 'long') THEN 'buy'
           WHEN LOWER(tj.direction) IN ('sell', 'short') THEN 'sell'
           ELSE LOWER(tj.direction)
         END AS actual_action_type,
         NULL::double precision AS actual_action_size_pct,
         tj.pnl_percent / 100.0 AS realized_reward,
         'return_fraction'::text AS outcome_unit,
         tj.is_paper
   FROM investment.trade_journal tj
   WHERE tj.symbol = e.symbol
     AND (
       tj.id::text = e.evidence->'outcomeLineage'->>'tradeJournalId'
       OR tj.trade_id::text = e.evidence->'outcomeLineage'->>'tradeId'
       OR tj.signal_id::text = linked_signal.signal_id
     )
     AND tj.pnl_percent IS NOT NULL
  UNION ALL
  SELECT t.entry_trade_id::text,
         2,
         'trades',
         t.actual_action_type,
         NULL::double precision,
         t.realized_reward,
         t.outcome_unit,
         t.is_paper
    FROM matched_trade_outcomes t
   WHERE t.symbol = e.symbol
     AND (
       t.entry_trade_id = e.evidence->'outcomeLineage'->>'tradeId'
       OR t.signal_id = linked_signal.signal_id
     )
     AND t.realized_reward IS NOT NULL
  UNION ALL
  SELECT o.id::text,
         3,
         'luna_strategy_signal_outcomes',
         NULL::text,
         NULL::double precision,
         COALESCE(o.realized_r::double precision, o.realized_pnl_pct::double precision / 100.0),
         CASE
           WHEN o.realized_r IS NOT NULL THEN 'r_multiple'
           ELSE 'return_fraction'
         END,
         TRUE
    FROM investment.luna_strategy_signal_outcomes o
   WHERE o.symbol = e.symbol
     AND e.evidence->'outcomeLineage'->>'strategySignalId' ~ '^[0-9]+$'
     AND o.signal_id = (e.evidence->'outcomeLineage'->>'strategySignalId')::BIGINT
     AND COALESCE(o.realized_r, o.realized_pnl_pct) IS NOT NULL
`;

export const RL_ENSEMBLE_REPORT_SQL = `
  WITH matched_trade_outcomes AS (
    ${buildMatchedTradeOutcomesSql()}
  ), entry_trigger_signal_links AS (
    SELECT s.block_meta->'entryTrigger'->>'triggerId' AS entry_trigger_id,
           UPPER(s.symbol) AS symbol_key,
           s.exchange,
           CASE WHEN COUNT(DISTINCT s.id) = 1 THEN MIN(s.id::text) END AS signal_id,
           COUNT(DISTINCT s.id)::integer AS signal_candidate_count
      FROM investment.signals s
     WHERE NULLIF(BTRIM(s.block_meta->'entryTrigger'->>'triggerId'), '') IS NOT NULL
     GROUP BY s.block_meta->'entryTrigger'->>'triggerId', UPPER(s.symbol), s.exchange
  )
  SELECT e.id, e.symbol, e.market, e.exchange, e.ensemble_model,
         e.action_type, e.action_size_pct, e.reward_estimate,
         e.algorithm_votes, e.observed_at,
         outcome.outcome_source, outcome.actual_action_type,
         outcome.actual_action_size_pct, outcome.realized_reward, outcome.outcome_unit,
         outcome.is_paper, outcome.outcome_status, outcome.outcome_candidate_count,
         EXISTS (
           SELECT 1
             FROM investment.trade_journal tj
            WHERE tj.symbol = e.symbol
              AND (
                tj.id::text = e.evidence->'outcomeLineage'->>'tradeJournalId'
                OR tj.trade_id::text = e.evidence->'outcomeLineage'->>'tradeId'
                OR tj.signal_id::text = linked_signal.signal_id
              )
              AND tj.pnl_percent IS NOT NULL
         ) AS journal_exact,
         EXISTS (
           SELECT 1
             FROM matched_trade_outcomes t
            WHERE t.symbol = e.symbol
              AND (
                t.entry_trade_id = e.evidence->'outcomeLineage'->>'tradeId'
                OR t.signal_id = linked_signal.signal_id
              )
         ) AS trades_exact,
         EXISTS (
           SELECT 1
             FROM matched_trade_outcomes t
            WHERE t.symbol = e.symbol
              AND (
                t.entry_trade_id = e.evidence->'outcomeLineage'->>'tradeId'
                OR t.signal_id = linked_signal.signal_id
              )
              AND t.outcome_status = 'multi_lot_excluded'
         ) AS trades_multi_lot_excluded,
         EXISTS (
           SELECT 1
             FROM matched_trade_outcomes t
            WHERE t.symbol = e.symbol
              AND (
                t.entry_trade_id = e.evidence->'outcomeLineage'->>'tradeId'
                OR t.signal_id = linked_signal.signal_id
              )
              AND t.outcome_status = 'partial_close_excluded'
         ) AS trades_partial_close_excluded,
         EXISTS (
           SELECT 1
             FROM investment.luna_strategy_signal_outcomes o
            WHERE o.symbol = e.symbol
              AND e.evidence->'outcomeLineage'->>'strategySignalId' ~ '^[0-9]+$'
              AND o.signal_id = (e.evidence->'outcomeLineage'->>'strategySignalId')::BIGINT
              AND COALESCE(o.realized_r, o.realized_pnl_pct) IS NOT NULL
         ) AS c8_exact,
         EXISTS (
           SELECT 1
             FROM investment.luna_rl_policy_shadow source_rl
            WHERE e.evidence->>'rlPolicyId' ~ '^[0-9]+$'
              AND source_rl.id = (e.evidence->>'rlPolicyId')::BIGINT
         ) AS rl_source_exact,
         linked_signal.signal_candidate_count = 1 AS entry_trigger_signal_exact
    FROM investment.luna_phase5_rl_ensemble_shadow e
    LEFT JOIN entry_trigger_signal_links linked_signal
      ON linked_signal.entry_trigger_id = e.evidence->'outcomeLineage'->>'entryTriggerId'
     AND linked_signal.symbol_key = UPPER(e.symbol)
     AND linked_signal.exchange = e.exchange
    LEFT JOIN LATERAL (
      ${buildLunaOutcomeSelectionSql(RL_OUTCOME_CANDIDATE_SQL)}
    ) outcome ON TRUE
   ORDER BY e.observed_at DESC, e.id DESC
   LIMIT NULLIF($1::int, 0)
`;

function finiteOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 6) {
  return value == null ? null : Number(Number(value).toFixed(digits));
}

function ratio(numerator, denominator) {
  return denominator > 0 ? round(numerator / denominator, 6) : null;
}

function parseVotes(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeOutcomeUnit(value) {
  const unit = String(value || '').trim().toLowerCase();
  return ['r_multiple', 'return_fraction'].includes(unit) ? unit : 'unknown';
}

function ranks(values) {
  const ordered = values
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value || left.index - right.index);
  const result = new Array(values.length);
  for (let start = 0; start < ordered.length;) {
    let end = start + 1;
    while (end < ordered.length && ordered[end].value === ordered[start].value) end += 1;
    const averageRank = ((start + 1) + end) / 2;
    for (let index = start; index < end; index += 1) result[ordered[index].index] = averageRank;
    start = end;
  }
  return result;
}

function pearsonCorrelation(left, right) {
  if (left.length < 2 || left.length !== right.length) return null;
  const leftMean = left.reduce((sum, value) => sum + value, 0) / left.length;
  const rightMean = right.reduce((sum, value) => sum + value, 0) / right.length;
  let numerator = 0;
  let leftSquares = 0;
  let rightSquares = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    numerator += leftDelta * rightDelta;
    leftSquares += leftDelta ** 2;
    rightSquares += rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftSquares * rightSquares);
  return denominator > 0 ? round(numerator / denominator) : null;
}

function policyScoreUnitEvaluation(outcomeUnit, items, minGroupN) {
  const pairs = items
    .map((item) => ({
      estimate: finiteOrNull(item.estimate),
      realized: finiteOrNull(item.realizedReward),
    }))
    .filter((item) => item.estimate != null && item.realized != null);
  const directionComparable = pairs.filter((item) => item.estimate !== 0 && item.realized !== 0);
  const directionMatches = directionComparable.filter((item) => Math.sign(item.estimate) === Math.sign(item.realized)).length;
  return {
    outcome_unit: outcomeUnit,
    n: pairs.length,
    status: pairs.length >= minGroupN ? 'sufficient' : 'insufficient',
    spearmanRankCorrelation: pearsonCorrelation(
      ranks(pairs.map((item) => item.estimate)),
      ranks(pairs.map((item) => item.realized)),
    ),
    directionComparableN: directionComparable.length,
    directionMatchRate: ratio(directionMatches, directionComparable.length),
    scoreThreshold: 0,
  };
}

function policyScoreEvaluation(items, minGroupN) {
  const groups = new Map();
  for (const item of items) {
    if (finiteOrNull(item.realizedReward) == null) continue;
    const unit = normalizeOutcomeUnit(item.outcomeUnit);
    if (!groups.has(unit)) groups.set(unit, []);
    groups.get(unit).push(item);
  }
  return {
    unit_mismatch: 'policy_score',
    policyScoreUnit: 'policy_score',
    mixedUnitAggregation: false,
    byOutcomeUnit: [...groups.entries()]
      .map(([unit, rows]) => policyScoreUnitEvaluation(unit, rows, minGroupN))
      .sort((left, right) => left.outcome_unit.localeCompare(right.outcome_unit)),
  };
}

function performanceRow(group, items, minGroupN) {
  const rawEvaluated = items.filter((item) => finiteOrNull(item.realizedReward) != null);
  const evaluated = rawEvaluated.filter((item) => item.outcomeOutlier !== true);
  const actionComparable = evaluated.filter((item) => item.recommendedAction && item.actualAction);
  const sizeComparable = evaluated.filter((item) => (
    finiteOrNull(item.recommendedSizePct) != null && finiteOrNull(item.actualSizePct) != null
  ));
  const actionMatches = actionComparable.filter((item) => item.recommendedAction === item.actualAction).length;
  const sizeErrors = sizeComparable.map((item) => Math.abs(Number(item.recommendedSizePct) - Number(item.actualSizePct)));
  const policyEvaluation = policyScoreEvaluation(evaluated, minGroupN);
  return {
    group,
    sampleRows: items.length,
    rawOutcomeN: rawEvaluated.length,
    n: evaluated.length,
    outlierExcludedN: rawEvaluated.length - evaluated.length,
    outcomeUnitStatuses: policyEvaluation.byOutcomeUnit.map((row) => ({
      outcome_unit: row.outcome_unit,
      n: row.n,
      status: row.status,
    })),
    actionComparableN: actionComparable.length,
    actionMatchRate: ratio(actionMatches, actionComparable.length),
    sizeComparableN: sizeComparable.length,
    sizeMaePct: sizeErrors.length > 0
      ? round(sizeErrors.reduce((sum, value) => sum + value, 0) / sizeErrors.length)
      : null,
    policyScoreEvaluation: policyEvaluation,
  };
}

function groupPerformance(items, groupOf, minGroupN) {
  const groups = new Map();
  for (const item of items) {
    const group = String(groupOf(item) || 'unknown');
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(item);
  }
  return [...groups.entries()]
    .map(([group, rows]) => performanceRow(group, rows, minGroupN))
    .sort((left, right) => right.n - left.n || left.group.localeCompare(right.group));
}

export function buildRlEnsembleReport(rows, { minGroupN = DEFAULT_MIN_GROUP_N } = {}) {
  const sourceMatches = {
    trade_journal: 0,
    trades: 0,
    luna_strategy_signal_outcomes: 0,
  };
  const items = (Array.isArray(rows) ? rows : []).map((row) => {
    const source = row.outcome_source || null;
    if (source && sourceMatches[source] !== undefined) sourceMatches[source] += 1;
    return {
      id: row.id ?? null,
      model: row.ensemble_model || 'unknown',
      recommendedAction: String(row.action_type || '').toLowerCase() || null,
      recommendedSizePct: finiteOrNull(row.action_size_pct),
      estimate: finiteOrNull(row.reward_estimate),
      actualAction: String(row.actual_action_type || '').toLowerCase() || null,
      actualSizePct: finiteOrNull(row.actual_action_size_pct),
      realizedReward: finiteOrNull(row.realized_reward),
      outcomeUnit: row.outcome_unit || null,
      outcomeSource: source,
      outcomeStatus: row.outcome_status || null,
      outcomeCandidateCount: finiteOrNull(row.outcome_candidate_count),
      votes: parseVotes(row.algorithm_votes),
    };
  });
  const outlierIsolation = isolateLunaOutcomeOutliers(items);
  const outlierRows = new Set(outlierIsolation.excluded);
  for (const item of items) item.outcomeOutlier = outlierRows.has(item);
  const exactSourceCounts = {
    trade_journal: rows.filter((row) => row.journal_exact === true || row.outcome_source === 'trade_journal').length,
    trades: rows.filter((row) => row.trades_exact === true || row.outcome_source === 'trades').length,
    luna_strategy_signal_outcomes: rows.filter((row) => row.c8_exact === true || row.outcome_source === 'luna_strategy_signal_outcomes').length,
  };
  const joinableRows = items.filter((item) => item.outcomeSource).length;
  const totalRows = items.length;
  const voteItems = items.flatMap((item) => item.votes.map((vote) => ({
    estimate: finiteOrNull(vote.score),
    realizedReward: item.realizedReward,
    outcomeUnit: item.outcomeUnit,
    recommendedAction: String(vote.action || '').toLowerCase() || null,
    actualAction: item.actualAction,
    recommendedSizePct: null,
    actualSizePct: null,
    algorithm: String(vote.algorithm || 'unknown').toLowerCase(),
    outcomeOutlier: item.outcomeOutlier,
  })));
  const overall = performanceRow('all', items, minGroupN);
  const joinAudit = {
    exactKey: ['symbol', 'evidence.outcomeLineage.*Id'],
    totalRows,
    joinableRows,
    unjoinableRows: totalRows - joinableRows,
    unjoinableRatio: ratio(totalRows - joinableRows, totalRows),
    sourceMatches: exactSourceCounts,
    canonicalSourceMatches: sourceMatches,
    rlSourceLineageExactRows: rows.filter((row) => row.rl_source_exact === true).length,
    entryTriggerSignalExactRows: rows.filter((row) => row.entry_trigger_signal_exact === true).length,
    actualSizePctAvailableRows: items.filter((item) => item.actualSizePct != null).length,
    multiLotExcludedRows: rows.filter((row) => row.trades_multi_lot_excluded === true).length,
    partialCloseExcludedRows: rows.filter((row) => row.trades_partial_close_excluded === true).length,
    ambiguousKeyExcludedRows: items.filter((item) => item.outcomeStatus === 'ambiguous_key_excluded').length,
    outlierExcludedRows: outlierIsolation.audit.excludedRows,
    outlierIsolation: outlierIsolation.audit,
    raceLesson: 'ensemble observed_at is a batch timestamp; only explicit outcome lineage IDs are eligible for exact joins',
  };
  const outcomeUnitStatuses = overall.policyScoreEvaluation.byOutcomeUnit
    .map((row) => `${row.outcome_unit}:${row.status}(n=${row.n})`)
    .join(', ') || 'none';
  const summary = `P5-C2 exact join ${joinableRows}/${totalRows}; unjoinable ${joinAudit.unjoinableRows} (${joinAudit.unjoinableRatio ?? 0}); ambiguous excluded ${joinAudit.ambiguousKeyExcludedRows}; partial closes excluded ${joinAudit.partialCloseExcludedRows}; outliers excluded ${joinAudit.outlierExcludedRows}; unit_mismatch=policy_score; outcome unit gates [${outcomeUnitStatuses}] (min=${minGroupN}).`;
  return {
    joinAudit,
    overall,
    byEnsembleModel: groupPerformance(items, (item) => item.model, minGroupN),
    byAlgorithmVote: groupPerformance(voteItems, (item) => item.algorithm, minGroupN),
    sampleGate: { minGroupN, basis: 'exactly joined rows, evaluated separately by outcome_unit' },
    summary,
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const limitArg = argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1];
  return {
    json: argv.includes('--json'),
    limit: Math.max(0, Number(limitArg || 0) || 0),
  };
}

export async function runLunaPhase5RlEnsembleReport(options = parseArgs(), deps = {}) {
  const queryFn = deps.query || db.query;
  const rows = await queryFn(RL_ENSEMBLE_REPORT_SQL, [options.limit || 0]);
  return buildRlEnsembleReport(rows);
}

async function main() {
  const options = parseArgs();
  const report = await runLunaPhase5RlEnsembleReport(options);
  if (!options.json) console.log(report.summary);
  console.log(JSON.stringify(report, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna phase5 RL ensemble report failed:',
  });
}
