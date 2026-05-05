#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { ensureCandidateUniverseTable } from '../team/discovery/discovery-store.ts';
import { ensureLunaDiscoveryEntryTables } from '../shared/luna-discovery-entry-store.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { evaluateKisMarketHours } from '../shared/kis-market-hours-guard.ts';
import {
  DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
  readPositionRuntimeAutopilotHistoryLines,
} from './runtime-position-runtime-autopilot-history-store.ts';

const MARKET_EXCHANGES = {
  crypto: 'binance',
  domestic: 'kis',
  overseas: 'kis_overseas',
};

function parseArgs(argv = process.argv.slice(2)) {
  return {
    json: argv.includes('--json'),
    telegram: argv.includes('--telegram'),
    hours: Math.max(1, Number(argv.find((arg) => arg.startsWith('--hours='))?.split('=')[1] || 24) || 24),
    market: argv.find((arg) => arg.startsWith('--market='))?.split('=')[1] || 'all',
    historyFile: argv.find((arg) => arg.startsWith('--history-file='))?.split('=').slice(1).join('=') || DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
  };
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeMarketScope(market = 'all') {
  const m = String(market || 'all').trim().toLowerCase();
  if (m === 'crypto' || m === 'domestic' || m === 'overseas') return [m];
  return ['crypto', 'domestic', 'overseas'];
}

function rowsToStateMap(rows = []) {
  return Object.fromEntries((rows || []).map((row) => [String(row.state || row.trigger_state || row.status || 'unknown'), number(row.count)]));
}

async function queryRows(sql, params = []) {
  return db.query(sql, params).catch(() => []);
}

async function buildMarketFunnel(market, { hours }) {
  const exchange = MARKET_EXCHANGES[market];
  const marketHours = market === 'crypto'
    ? { market, isOpen: true, state: 'open', reasonCode: 'crypto_24h_market', nextAction: 'allow' }
    : evaluateKisMarketHours({ market });
  const [candidateRows, sourceRows, signalRows, triggerRows, latestCandidates, latestTriggers] = await Promise.all([
    queryRows(
      `SELECT
         COUNT(*)::int AS active_count,
         COUNT(*) FILTER (WHERE discovered_at >= now() - ($2::int * INTERVAL '1 hour'))::int AS recent_count,
         AVG(score)::float AS avg_score,
         MAX(discovered_at) AS latest_discovered_at
       FROM candidate_universe
       WHERE market = $1
         AND expires_at > now()`,
      [market, hours],
    ),
    queryRows(
      `SELECT quality_status, COUNT(*)::int AS count, COALESCE(SUM(signal_count), 0)::int AS signal_count, MAX(captured_at) AS latest_captured_at
       FROM discovery_source_metrics
       WHERE market = $1
         AND captured_at >= now() - ($2::int * INTERVAL '1 hour')
       GROUP BY quality_status
       ORDER BY count DESC`,
      [market, hours],
    ),
    queryRows(
      `SELECT COALESCE(status, 'unknown') AS status,
              COALESCE(action, 'unknown') AS action,
              (
                COALESCE(exclude_from_learning, false) = true
                OR COALESCE(quality_flag, '') = 'exclude_from_learning'
                OR COALESCE(block_code, '') = 'synthetic_reflection_signal'
                OR symbol LIKE 'REFLECT_%'
              ) AS ignored,
              COUNT(*)::int AS count,
              MAX(created_at) AS latest_created_at
       FROM signals
       WHERE exchange = $1
         AND created_at >= now() - ($2::int * INTERVAL '1 hour')
       GROUP BY status, action, ignored
       ORDER BY count DESC`,
      [exchange, hours],
    ),
    queryRows(
      `SELECT trigger_state AS state, COUNT(*)::int AS count, MAX(COALESCE(fired_at, updated_at, created_at)) AS latest_at
       FROM entry_triggers
       WHERE exchange = $1
         AND COALESCE(fired_at, updated_at, created_at) >= now() - ($2::int * INTERVAL '1 hour')
       GROUP BY trigger_state
       ORDER BY count DESC`,
      [exchange, hours],
    ),
    queryRows(
      `SELECT symbol, source, score::float AS score, confidence, reason_code, discovered_at, expires_at
       FROM candidate_universe
       WHERE market = $1
         AND expires_at > now()
       ORDER BY score DESC, discovered_at DESC
       LIMIT 10`,
      [market],
    ),
    queryRows(
      `SELECT symbol, trigger_type, trigger_state, confidence, predictive_score, updated_at, fired_at, created_at
       FROM entry_triggers
       WHERE exchange = $1
       ORDER BY COALESCE(fired_at, updated_at, created_at) DESC
       LIMIT 10`,
      [exchange],
    ),
  ]);

  const candidate = candidateRows?.[0] || {};
  const signalsByStatus = {};
  const signalsByAction = {};
  const ignoredSignalsByAction = {};
  let ignoredSignalCount = 0;
  for (const row of signalRows || []) {
    if (row.ignored === true || row.ignored === 't') {
      ignoredSignalCount += number(row.count);
      ignoredSignalsByAction[row.action] = (ignoredSignalsByAction[row.action] || 0) + number(row.count);
      continue;
    }
    signalsByStatus[row.status] = (signalsByStatus[row.status] || 0) + number(row.count);
    signalsByAction[row.action] = (signalsByAction[row.action] || 0) + number(row.count);
  }
  const triggerByState = rowsToStateMap(triggerRows);
  const activeTriggerCount = number(triggerByState.armed) + number(triggerByState.waiting);
  const recentSignalCount = signalRows.reduce((sum, row) => sum + number(row.count), 0);
  const recentBuySignals = number(signalsByAction.BUY);
  const sourceSignalCount = sourceRows.reduce((sum, row) => sum + number(row.signal_count), 0);
  const bottlenecks = [];
  const marketOpen = marketHours.isOpen === true;
  if (number(candidate.active_count) === 0) bottlenecks.push('discovery_candidate_empty');
  if (sourceSignalCount === 0) bottlenecks.push('source_metric_empty');
  if (!marketOpen && number(candidate.active_count) > 0) bottlenecks.push('market_closed_waiting_open');
  if (marketOpen && number(candidate.active_count) > 0 && recentSignalCount === 0) bottlenecks.push('candidate_not_persisted_to_signal_window');
  if (recentBuySignals > 0 && activeTriggerCount === 0) bottlenecks.push('buy_signal_without_active_entry_trigger');
  if (activeTriggerCount === 0 && number(triggerByState.expired) > 0) bottlenecks.push('entry_triggers_expired_without_active_replacement');
  if (marketOpen && number(candidate.active_count) > 0 && activeTriggerCount === 0 && recentBuySignals === 0) bottlenecks.push('candidates_filtered_before_entry_trigger');

  return {
    market,
    exchange,
    marketHours,
    candidateUniverse: {
      activeCount: number(candidate.active_count),
      recentCount: number(candidate.recent_count),
      avgScore: candidate.avg_score != null ? number(candidate.avg_score) : null,
      latestDiscoveredAt: candidate.latest_discovered_at || null,
      top: latestCandidates || [],
    },
    sourceMetrics: {
      rows: sourceRows || [],
      signalCount: sourceSignalCount,
    },
    signalPersistence: {
      recentCount: recentSignalCount,
      buyCount: recentBuySignals,
      ignoredCount: ignoredSignalCount,
      ignoredByAction: ignoredSignalsByAction,
      byStatus: signalsByStatus,
      byAction: signalsByAction,
    },
    entryTriggers: {
      activeCount: activeTriggerCount,
      recentByState: triggerByState,
      latest: latestTriggers || [],
    },
    bottlenecks,
  };
}

function buildAutopilotFunnel({ historyFile, hours }) {
  const cutoff = Date.now() - (Math.max(1, Number(hours || 24)) * 3600 * 1000);
  const rows = readPositionRuntimeAutopilotHistoryLines(historyFile)
    .filter((row) => {
      const ts = new Date(row?.recordedAt || 0).getTime();
      return Number.isFinite(ts) && ts >= cutoff;
    });
  const totals = {
    samples: rows.length,
    candidateCount: 0,
    executedCount: 0,
    queuedCount: 0,
    retryingCount: 0,
    skippedCount: 0,
    failureCount: 0,
    marketQueueTotal: 0,
    marketQueueWaitingOpen: 0,
  };
  for (const row of rows) {
    totals.candidateCount += number(row.dispatchCandidateCount);
    totals.executedCount += number(row.dispatchExecutedCount);
    totals.queuedCount += number(row.dispatchQueuedCount);
    totals.retryingCount += number(row.dispatchRetryingCount);
    totals.skippedCount += number(row.dispatchSkippedCount);
    totals.failureCount += number(row.dispatchFailureCount);
    totals.marketQueueTotal += number(row.dispatchMarketQueue?.total);
    totals.marketQueueWaitingOpen += number(row.dispatchMarketQueue?.waitingMarketOpen);
  }
  return {
    historyFile,
    latestRecordedAt: rows[rows.length - 1]?.recordedAt || null,
    latestStatus: rows[rows.length - 1]?.status || null,
    totals,
  };
}

export async function buildLunaDiscoveryFunnelReport({
  hours = 24,
  market = 'all',
  historyFile = DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
} = {}) {
  await db.initSchema();
  await ensureCandidateUniverseTable();
  await ensureLunaDiscoveryEntryTables();
  const markets = normalizeMarketScope(market);
  const marketReports = await Promise.all(markets.map((m) => buildMarketFunnel(m, { hours })));
  const autopilot = buildAutopilotFunnel({ historyFile, hours });
  const allBottlenecks = marketReports.flatMap((item) => item.bottlenecks.map((code) => `${item.market}:${code}`));
  const candidateTotal = marketReports.reduce((sum, item) => sum + item.candidateUniverse.activeCount, 0);
  const activeTriggerTotal = marketReports.reduce((sum, item) => sum + item.entryTriggers.activeCount, 0);
  const recommendations = [];
  if (candidateTotal === 0) recommendations.push('all_markets_discovery_candidate_empty');
  if (candidateTotal > 0 && activeTriggerTotal === 0) recommendations.push('candidate_to_entry_trigger_funnel_needs_review');
  if (autopilot.totals.samples === 0) recommendations.push('runtime_autopilot_history_missing');
  if (autopilot.totals.candidateCount === 0) recommendations.push('dispatch_idle_no_candidates_in_window');
  return {
    ok: true,
    status: allBottlenecks.length ? 'luna_discovery_funnel_attention' : 'luna_discovery_funnel_clear',
    generatedAt: new Date().toISOString(),
    hours,
    market,
    markets: marketReports,
    autopilot,
    bottlenecks: allBottlenecks,
    recommendations,
    nextAction: recommendations.includes('candidate_to_entry_trigger_funnel_needs_review')
      ? 'inspect_score_fusion_predictive_validation_entry_trigger_thresholds'
      : recommendations.includes('all_markets_discovery_candidate_empty')
        ? 'inspect_discovery_orchestrator_sources'
        : recommendations.includes('dispatch_idle_no_candidates_in_window')
          ? 'continue_observation_or_lower_discovery_thresholds_after_review'
          : 'continue_observation',
  };
}

export function renderLunaDiscoveryFunnelReport(report = {}) {
  const lines = [
    '🔎 루나 discovery funnel 병목 리포트',
    `checkedAt: ${report.generatedAt || 'n/a'}`,
    `window: ${report.hours || 24}h / market=${report.market || 'all'}`,
    `status: ${report.status || 'unknown'}`,
  ];
  for (const item of report.markets || []) {
    lines.push(
      `${item.market}: market=${item.marketHours?.state || 'unknown'} candidates=${item.candidateUniverse?.activeCount || 0} recentSignals=${item.signalPersistence?.recentCount || 0} buySignals=${item.signalPersistence?.buyCount || 0} activeTriggers=${item.entryTriggers?.activeCount || 0} bottlenecks=${(item.bottlenecks || []).join(',') || 'none'}`,
    );
  }
  lines.push(`dispatch: samples=${report.autopilot?.totals?.samples || 0} candidates=${report.autopilot?.totals?.candidateCount || 0} executed=${report.autopilot?.totals?.executedCount || 0} failures=${report.autopilot?.totals?.failureCount || 0}`);
  lines.push(`nextAction: ${report.nextAction || 'n/a'}`);
  return lines.join('\n');
}

async function publishReport(report) {
  return publishAlert({
    from_bot: 'luna',
    event_type: 'report',
    alert_level: report.bottlenecks?.length ? 2 : 1,
    message: renderLunaDiscoveryFunnelReport(report),
    payload: report,
  });
}

async function main() {
  const args = parseArgs();
  const report = await buildLunaDiscoveryFunnelReport(args);
  if (args.telegram) await publishReport(report);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderLunaDiscoveryFunnelReport(report));
  return report;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-luna-discovery-funnel-report 실패:',
  });
}
