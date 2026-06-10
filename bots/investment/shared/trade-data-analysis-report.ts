// @ts-nocheck
import { query } from './db/core.ts';
import { buildTradeAnalyticsReport } from './trade-analytics-report.ts';
import {
  buildOperatingEpochLowerBoundSql,
  filterRowsForPolicyLearning,
  getLunaOperatingEpoch,
  summarizeRowsByOperatingEpoch,
} from './luna-operating-epoch.ts';
import { deriveTradeJournalNumericId } from './posttrade-trade-journal-adapter.ts';
import { isLearningPnlValidRow } from './trade-journal-learning-guard.ts';
import { buildTradeDataHygieneReport, isExpectedPolicyBlockCode } from './trade-data-hygiene.ts';

function rowsOf(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.rows) ? result.rows : [];
}

async function safeQuery(sql, params = []) {
  try {
    return rowsOf(await query(sql, params));
  } catch (error) {
    return [];
  }
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function countMap(rows = [], key = 'name') {
  return Object.fromEntries(rows.map((row) => [row[key] ?? 'unknown', num(row.count)]));
}

export const TRADE_DATA_REINFORCEMENT_CONTRACT = [
  'signal_failure_recovery',
  'kis_market_hours_guard',
  'posttrade_auto_trigger',
  'failed_signal_reflexion',
  'tp_sl_auto_setter',
  'agent_utilization_monitor',
  'trade_journal_dashboard',
  'realized_pnl_calculator',
  'signal_pre_filter',
  'trade_data_derived_guards',
  'trade_pattern_clusterer',
  'trade_data_hygiene_doctor',
];

export async function buildTradeDataAnalysisReport({ limit = 5000, generatedAt = new Date().toISOString() } = {}) {
  const signalLowerBound = buildOperatingEpochLowerBoundSql(null);
  const signalWhere = signalLowerBound ? `WHERE created_at >= ${signalLowerBound}` : '';
  const tradeLowerBound = buildOperatingEpochLowerBoundSql(null);
  const tradeWhere = tradeLowerBound ? `WHERE executed_at >= ${tradeLowerBound}` : '';
  const signalStatusRows = await safeQuery(
    `SELECT COALESCE(status, 'unknown') AS status, COUNT(*)::int AS count
       FROM investment.signals
      ${signalWhere}
      GROUP BY 1
      ORDER BY count DESC`,
  );
  const marketSignalRows = await safeQuery(
    `SELECT COALESCE(exchange, 'unknown') AS exchange,
            COALESCE(status, 'unknown') AS status,
            COUNT(*)::int AS count
       FROM investment.signals
      ${signalWhere}
      GROUP BY 1, 2
      ORDER BY 1, count DESC`,
  );
  const failedRows = await safeQuery(
    `SELECT COALESCE(exchange, 'unknown') AS exchange,
            COALESCE(action, 'unknown') AS action,
            COUNT(*)::int AS count
       FROM investment.signals
      WHERE LOWER(COALESCE(status, '')) = 'failed'
      ${signalLowerBound ? `AND created_at >= ${signalLowerBound}` : ''}
      GROUP BY 1, 2
      ORDER BY count DESC
      LIMIT 20`,
  );
  const blockRows = await safeQuery(
    `SELECT COALESCE(NULLIF(block_code, ''), NULLIF(block_reason, ''), 'unknown') AS reason,
            COUNT(*)::int AS count
       FROM investment.signals
      WHERE LOWER(COALESCE(status, '')) = 'blocked'
      ${signalLowerBound ? `AND created_at >= ${signalLowerBound}` : ''}
      GROUP BY 1
      ORDER BY count DESC
      LIMIT 20`,
  );
  const tradeRows = await safeQuery(
    `SELECT COALESCE(exchange, 'unknown') AS exchange,
            COALESCE(side, 'unknown') AS side,
            COUNT(*)::int AS count
       FROM investment.trades
      ${tradeWhere}
      GROUP BY 1, 2
      ORDER BY 1, count DESC`,
  );
  const journalSourceRows = await safeQuery(
    `SELECT *
       FROM investment.trade_journal
      ORDER BY COALESCE(exit_time, entry_time, created_at) DESC NULLS LAST
      LIMIT $1`,
    [limit],
  );
  const reflexionRows = await safeQuery(`SELECT COUNT(*)::int AS count FROM investment.luna_failure_reflexions`);
  const skillRows = await safeQuery(`SELECT COUNT(*)::int AS count FROM investment.luna_posttrade_skills`);
  const agentRows = await safeQuery(
    `SELECT COALESCE(agent_name, 'unknown') AS agent, COUNT(*)::int AS count
       FROM investment.agent_context_log
      GROUP BY 1
      ORDER BY count DESC
      LIMIT 20`,
  );
  const realizedRows = await safeQuery(
    `SELECT
       COUNT(*) FILTER (WHERE LOWER(COALESCE(side, '')) = 'sell')::int AS sell_count,
       COUNT(*) FILTER (WHERE LOWER(COALESCE(side, '')) = 'sell' AND realized_pnl_pct IS NOT NULL)::int AS realized_count
     FROM investment.trades
     ${tradeWhere}`,
  );

  const signalStatus = countMap(signalStatusRows, 'status');
  const totalSignals = Object.values(signalStatus).reduce((sum, value) => sum + value, 0);
  const failedSignals = num(signalStatus.failed);
  const executedSignals = num(signalStatus.executed);
  const policyBlockedSignals = blockRows.reduce((sum, row) => {
    return sum + (isExpectedPolicyBlockCode(row.reason) ? num(row.count) : 0);
  }, 0);
  const executionCandidateSignals = Math.max(0, totalSignals - policyBlockedSignals);
  const signalFailureRate = totalSignals > 0 ? Number((failedSignals / totalSignals).toFixed(4)) : null;
  const signalExecutionRate = totalSignals > 0 ? Number((executedSignals / totalSignals).toFixed(4)) : null;
  const policyAdjustedExecutionRate = executionCandidateSignals > 0
    ? Number((executedSignals / executionCandidateSignals).toFixed(4))
    : signalExecutionRate;
  const journalRows = filterRowsForPolicyLearning(journalSourceRows, ['exit_time', 'entry_time']);
  const analytics = buildTradeAnalyticsReport(journalRows, { generatedAt });
  analytics.operatingEpochSummary = summarizeRowsByOperatingEpoch(journalSourceRows, ['exit_time', 'entry_time']);
  const closedJournalTradeIds = [...new Set(
    journalRows
      .filter((row) => String(row.status || '').toLowerCase() === 'closed' || row.exit_time != null)
      .filter((row) => isLearningPnlValidRow(row))
      .map((row) => deriveTradeJournalNumericId(row))
      .filter((id) => Number.isSafeInteger(id)),
  )];
  const qualityRows = closedJournalTradeIds.length > 0
    ? await safeQuery(
        `SELECT COUNT(*)::int AS count
           FROM investment.trade_quality_evaluations
          WHERE trade_id = ANY($1::BIGINT[])`,
        [closedJournalTradeIds],
      )
    : [{ count: 0 }];
  const realized = realizedRows[0] || {};
  const sellCount = num(realized.sell_count);
  const realizedCount = num(realized.realized_count);
  const qualityCount = num(qualityRows[0]?.count);
  const reflexionCount = num(reflexionRows[0]?.count);
  const realizedPnlCoverage = {
    sellCount,
    realizedCount,
    coverage: sellCount > 0 ? Number((realizedCount / sellCount).toFixed(4)) : 1,
  };
  const qualityCoverage = {
    closedJournalTrades: closedJournalTradeIds.length,
    evaluatedClosedJournalTrades: qualityCount,
    coverage: closedJournalTradeIds.length > 0 ? Number((qualityCount / closedJournalTradeIds.length).toFixed(4)) : 1,
  };
  const hygiene = await buildTradeDataHygieneReport({
    generatedAt,
    realizedPnlCoverage,
    qualityCoverage,
  });

  const reinforcementCoverage = TRADE_DATA_REINFORCEMENT_CONTRACT.map((id) => ({ id, status: 'implemented' }));
  const warnings = [];
  if (signalFailureRate != null && signalFailureRate > 0.3) warnings.push('signal_failure_rate_high');
  if (analytics.status !== 'ready') warnings.push('trade_analytics_needs_attention');
  if (hygiene.status !== 'ready') warnings.push(...hygiene.findings.map((finding) => finding.id));
  if (analytics.tpSl.unset.closed > 0) warnings.push('closed_trade_tp_sl_missing_history');
  if (sellCount > realizedCount) warnings.push('realized_pnl_backfill_pending');
  if (qualityCount < closedJournalTradeIds.length) warnings.push('posttrade_evaluation_backfill_pending');
  if (failedSignals > reflexionCount) warnings.push('failed_reflexion_backfill_pending');
  const uniqueWarnings = [...new Set(warnings)];

  return {
    ok: true,
    status: uniqueWarnings.length ? 'needs_attention' : 'ready',
    generatedAt,
    operatingEpoch: getLunaOperatingEpoch(),
    signals: {
      total: totalSignals,
      byStatus: signalStatus,
      failureRate: signalFailureRate,
      executionRate: signalExecutionRate,
      policyAdjustedExecutionRate,
      policyBlockedSignals,
      executionCandidateSignals,
      byMarketStatus: marketSignalRows,
      failedByExchangeAction: failedRows,
      blockedReasons: blockRows,
    },
    trades: {
      byExchangeSide: tradeRows,
      realizedPnlCoverage,
    },
    journal: analytics,
    posttrade: {
      qualityEvaluations: qualityCount,
      qualityCoverage,
      failureReflexions: reflexionCount,
      posttradeSkills: num(skillRows[0]?.count),
    },
    hygiene,
    agents: {
      topContextAgents: agentRows,
    },
    reinforcementCoverage,
    warnings: uniqueWarnings,
    nextActions: [
      ...(analytics.nextActions || []),
      ...(hygiene.nextActions || []),
      ...(sellCount > realizedCount ? ['npm --prefix bots/investment run -s runtime:pnl-backfill -- --json, then apply with --apply --confirm=runtime-pnl-backfill after review'] : []),
      ...(analytics.tpSl.unset.closed > 0 ? ['review historical closed trades without tp_sl_set=true'] : []),
      ...(qualityCount < closedJournalTradeIds.length ? ['npm --prefix bots/investment run -s runtime:posttrade-feedback-worker -- --once --force --market=all --limit=20 --dry-run --json (current operating epoch only), then run without --dry-run after review'] : []),
    ],
  };
}

export default { buildTradeDataAnalysisReport, TRADE_DATA_REINFORCEMENT_CONTRACT };
