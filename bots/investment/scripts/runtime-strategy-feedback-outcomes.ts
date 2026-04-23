#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { initJournalSchema } from '../shared/trade-journal-db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const args = { days: 90, json: false };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw.startsWith('--days=')) args.days = Math.max(1, Number(raw.split('=').slice(1).join('=') || 90));
  }
  return args;
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function extractTag(text = '', key = '') {
  const pattern = new RegExp(`${key}=([^:]+)`);
  return String(text || '').match(pattern)?.[1] || null;
}

function pct(value, digits = 1) {
  if (value == null || value === '') return 'n/a';
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  return `${n.toFixed(digits)}%`;
}

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '$0.00';
  return `${n >= 0 ? '+' : '-'}$${Math.abs(n).toFixed(2)}`;
}

function summarizeContext(context = {}) {
  const feedbackSignals = safeNumber(context.feedbackSignals);
  const taggedFeedbackSignals = safeNumber(context.taggedFeedbackSignals);
  const taggedTrades = safeNumber(context.taggedTrades);
  const taggedJournals = safeNumber(context.taggedJournals);
  const activeFeedbackCandidates = safeNumber(context.activeFeedbackCandidates);
  return [
    `signals ${feedbackSignals}`,
    `taggedSignals ${taggedFeedbackSignals}`,
    `taggedTrades ${taggedTrades}`,
    `taggedJournals ${taggedJournals}`,
    `activeCandidates ${activeFeedbackCandidates}`,
  ].join(', ');
}

export function normalizeStrategyFeedbackOutcomeRow(row = {}) {
  const incident = String(row.incident_link || '');
  const familyBias = extractTag(incident, 'family_bias') || 'unknown';
  const family = extractTag(incident, 'family') || row.strategy_family || 'unknown';
  const closed = safeNumber(row.closed);
  const wins = safeNumber(row.wins);
  return {
    familyBias,
    family,
    executionKind: String(row.execution_kind || 'unknown'),
    total: safeNumber(row.total),
    closed,
    wins,
    winRate: closed > 0 ? wins / closed : null,
    avgPnlPercent: row.avg_pnl_percent != null ? Number(row.avg_pnl_percent) : null,
    pnlNet: safeNumber(row.pnl_net),
    latestCreatedAt: row.latest_created_at != null ? Number(row.latest_created_at) : null,
  };
}

export function aggregateStrategyFeedbackOutcomeRows(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.familyBias}::${row.family}::${row.executionKind}`;
    const bucket = groups.get(key) || {
      familyBias: row.familyBias,
      family: row.family,
      executionKind: row.executionKind,
      total: 0,
      closed: 0,
      wins: 0,
      pnlNet: 0,
      pnlPercentWeightedSum: 0,
      latestCreatedAt: null,
    };
    bucket.total += safeNumber(row.total);
    bucket.closed += safeNumber(row.closed);
    bucket.wins += safeNumber(row.wins);
    bucket.pnlNet += safeNumber(row.pnlNet);
    if (row.avgPnlPercent != null && row.closed > 0) {
      bucket.pnlPercentWeightedSum += Number(row.avgPnlPercent) * Number(row.closed);
    }
    if (row.latestCreatedAt != null) {
      bucket.latestCreatedAt = bucket.latestCreatedAt == null
        ? row.latestCreatedAt
        : Math.max(Number(bucket.latestCreatedAt), Number(row.latestCreatedAt));
    }
    groups.set(key, bucket);
  }

  return [...groups.values()]
    .map((bucket) => ({
      familyBias: bucket.familyBias,
      family: bucket.family,
      executionKind: bucket.executionKind,
      total: bucket.total,
      closed: bucket.closed,
      wins: bucket.wins,
      winRate: bucket.closed > 0 ? bucket.wins / bucket.closed : null,
      avgPnlPercent: bucket.closed > 0 ? Number((bucket.pnlPercentWeightedSum / bucket.closed).toFixed(4)) : null,
      pnlNet: Number(bucket.pnlNet.toFixed(4)),
      latestCreatedAt: bucket.latestCreatedAt,
    }))
    .sort((a, b) =>
      Number(b.total || 0) - Number(a.total || 0)
      || Number(b.closed || 0) - Number(a.closed || 0)
      || Number(b.latestCreatedAt || 0) - Number(a.latestCreatedAt || 0),
    );
}

export function buildDecision(rows = [], sampleContext = {}) {
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const closed = rows.reduce((sum, row) => sum + row.closed, 0);
  const pnlNet = rows.reduce((sum, row) => sum + row.pnlNet, 0);
  const weak = rows
    .filter((row) => row.closed >= 3 && row.avgPnlPercent != null)
    .sort((a, b) => Number(a.avgPnlPercent) - Number(b.avgPnlPercent))[0] || null;
  const strong = rows
    .filter((row) => row.closed >= 3 && row.avgPnlPercent != null)
    .sort((a, b) => Number(b.avgPnlPercent) - Number(a.avgPnlPercent))[0] || null;

  let status = 'strategy_feedback_outcome_empty';
  let headline = '아직 전략 패밀리 피드백 태그가 붙은 체결 결과가 없습니다.';
  const actionItems = ['새 partial-adjust/strategy-exit 실행 이후 다시 확인합니다.'];
  const reasons = [
    `tagged buckets ${rows.length}, trades ${total}, closed ${closed}, pnl ${money(pnlNet)}`,
    `sample context: ${summarizeContext(sampleContext)}`,
  ];

  if (total > 0) {
    status = weak && Number(weak.avgPnlPercent) < -2 ? 'strategy_feedback_outcome_attention' : 'strategy_feedback_outcome_watch';
    headline = weak && Number(weak.avgPnlPercent) < -2
      ? `${weak.familyBias}/${weak.family} 피드백 실행 결과가 약해 추가 감점 또는 exit 기준 재검토가 필요할 수 있습니다.`
      : '전략 패밀리 피드백이 붙은 실행 결과가 누적되기 시작했습니다.';
    actionItems.length = 0;
    actionItems.push('피드백 태그별 partial-adjust/strategy-exit 결과를 다음 리뷰에서 비교합니다.');
    if (strong) actionItems.push(`${strong.familyBias}/${strong.family} 결과는 기준선 후보로 계속 누적합니다.`);
    if (weak) actionItems.push(`${weak.familyBias}/${weak.family} 결과는 손익과 승률을 함께 관찰합니다.`);
  } else if (
    safeNumber(sampleContext.feedbackSignals) > 0
    || safeNumber(sampleContext.taggedFeedbackSignals) > 0
    || safeNumber(sampleContext.taggedTrades) > 0
  ) {
    status = 'strategy_feedback_outcome_telemetry_gap';
    headline = '전략 피드백 실행 흔적은 있지만 trade_journal 결과 태그가 누적되지 않습니다.';
    actionItems.length = 0;
    actionItems.push('journal:backfill-incident-links -- --family-bias-only 결과와 SELL 실행 저장 경로를 점검합니다.');
    actionItems.push('partial-adjust/strategy-exit 체결 이후 signal/trade incident_link가 trade_journal로 이어지는지 확인합니다.');
  } else {
    status = safeNumber(sampleContext.activeFeedbackCandidates) > 0
      ? 'strategy_feedback_outcome_waiting_execution'
      : 'strategy_feedback_outcome_waiting_signal';
    headline = safeNumber(sampleContext.activeFeedbackCandidates) > 0
      ? '전략 피드백 후보는 있지만 아직 실행 표본이 없어 결과 누적을 기다리는 상태입니다.'
      : '아직 partial-adjust/strategy-exit 피드백 실행 표본이 없어 결과 누적을 기다리는 상태입니다.';
    actionItems.length = 0;
    actionItems.push('후보 preview가 뜬 뒤 승인형 partial-adjust/strategy-exit 실행 결과가 생기면 자동으로 outcome 버킷에 반영됩니다.');
    actionItems.push('현재는 전역 상수 변경보다 실행 표본 생성과 저널 연결 확인이 우선입니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: { total, closed, pnlNet, weak, strong, sampleContext },
  };
}

function renderText(payload) {
  const { days, rows, decision } = payload;
  const lines = [
    '🧪 Strategy Feedback Outcomes',
    `period: ${days}d`,
    `status: ${decision.status}`,
    `headline: ${decision.headline}`,
    '',
    '근거:',
    ...decision.reasons.map((reason) => `- ${reason}`),
    '',
    '피드백별 결과:',
  ];

  if (rows.length === 0) lines.push('- 데이터 없음');
  for (const row of rows) {
    lines.push(`- ${row.familyBias}/${row.family}/${row.executionKind}: total ${row.total}, closed ${row.closed}, win ${pct((row.winRate || 0) * 100, 1)}, avg ${pct(row.avgPnlPercent, 2)}, pnl ${money(row.pnlNet)}`);
  }

  lines.push('');
  lines.push('권장 조치:');
  lines.push(...decision.actionItems.map((item) => `- ${item}`));
  return lines.join('\n');
}

async function loadStrategyFeedbackSampleContext(days = 90, sinceMs = null) {
  const safeDays = Math.max(1, Number(days || 90));
  const since = sinceMs ?? Date.now() - safeDays * 24 * 60 * 60 * 1000;
  const rows = await db.query(`
    WITH signal_scope AS (
      SELECT *
      FROM investment.signals
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 day')
    ),
    trade_scope AS (
      SELECT *
      FROM investment.trades
      WHERE executed_at >= NOW() - ($1::int * INTERVAL '1 day')
    ),
    journal_scope AS (
      SELECT *
      FROM investment.trade_journal
      WHERE created_at >= $2
    ),
    profile_scope AS (
      SELECT *
      FROM investment.position_strategy_profiles
      WHERE status = 'active'
    )
    SELECT
      COUNT(*) FILTER (
        WHERE s.incident_link LIKE 'partial_adjust:%'
           OR s.incident_link LIKE 'strategy_exit:%'
      ) AS feedback_signals,
      COUNT(*) FILTER (
        WHERE (
          s.incident_link LIKE 'partial_adjust:%'
          OR s.incident_link LIKE 'strategy_exit:%'
        )
        AND s.incident_link LIKE '%family_bias=%'
      ) AS tagged_feedback_signals,
      COUNT(*) FILTER (
        WHERE s.action = 'SELL'
          AND COALESCE(s.execution_origin, '') = 'strategy'
      ) AS strategy_sell_signals,
      COUNT(*) FILTER (
        WHERE s.incident_link LIKE '%family_bias=%'
          AND s.status IN ('executed', 'closed', 'completed', 'filled')
      ) AS tagged_executed_signals,
      (SELECT COUNT(*) FROM trade_scope t WHERE t.incident_link LIKE '%family_bias=%') AS tagged_trades,
      (SELECT COUNT(*) FROM journal_scope j WHERE j.incident_link LIKE '%family_bias=%') AS tagged_journals,
      (SELECT COUNT(*) FROM journal_scope j WHERE j.incident_link LIKE 'partial_adjust:%') AS journal_partial_adjusts,
      (SELECT COUNT(*) FROM journal_scope j WHERE j.incident_link LIKE 'strategy_exit:%') AS journal_strategy_exits,
      (
        SELECT COUNT(*)
        FROM profile_scope p
        WHERE p.strategy_state->>'latestRecommendation' IN ('ADJUST', 'EXIT')
      ) AS active_feedback_candidates,
      (
        SELECT COUNT(*)
        FROM profile_scope p
        WHERE COALESCE(p.strategy_state->>'latestFamilyPerformanceBias', '') NOT IN ('', 'unknown')
      ) AS active_family_bias_profiles
    FROM signal_scope s
  `, [safeDays, since]).catch(() => []);
  const row = rows[0] || {};
  return {
    days: safeDays,
    feedbackSignals: safeNumber(row.feedback_signals),
    taggedFeedbackSignals: safeNumber(row.tagged_feedback_signals),
    strategySellSignals: safeNumber(row.strategy_sell_signals),
    taggedExecutedSignals: safeNumber(row.tagged_executed_signals),
    taggedTrades: safeNumber(row.tagged_trades),
    taggedJournals: safeNumber(row.tagged_journals),
    journalPartialAdjusts: safeNumber(row.journal_partial_adjusts),
    journalStrategyExits: safeNumber(row.journal_strategy_exits),
    activeFeedbackCandidates: safeNumber(row.active_feedback_candidates),
    activeFamilyBiasProfiles: safeNumber(row.active_family_bias_profiles),
  };
}

export async function buildStrategyFeedbackOutcomes({ days = 90, json = false } = {}) {
  await db.initSchema();
  await initJournalSchema();
  const since = Date.now() - Math.max(1, Number(days || 90)) * 24 * 60 * 60 * 1000;
  const rawRows = await db.query(`
    SELECT
      CASE
        WHEN incident_link LIKE 'partial_adjust:%' THEN 'partial_adjust'
        WHEN incident_link LIKE 'strategy_exit:%' THEN 'strategy_exit'
        ELSE 'other'
      END AS execution_kind,
      incident_link,
      COALESCE(NULLIF(strategy_family, ''), 'unknown') AS strategy_family,
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'closed' OR exit_time IS NOT NULL) AS closed,
      COUNT(*) FILTER (WHERE (status = 'closed' OR exit_time IS NOT NULL) AND COALESCE(pnl_net, pnl_amount, 0) > 0) AS wins,
      ROUND(AVG(CASE WHEN status = 'closed' OR exit_time IS NOT NULL THEN pnl_percent ELSE NULL END)::numeric, 4) AS avg_pnl_percent,
      ROUND(SUM(CASE WHEN status = 'closed' OR exit_time IS NOT NULL THEN COALESCE(pnl_net, pnl_amount, 0) ELSE 0 END)::numeric, 4) AS pnl_net,
      MAX(created_at) AS latest_created_at
    FROM investment.trade_journal
    WHERE created_at >= $1
      AND incident_link LIKE '%family_bias=%'
    GROUP BY 1, 2, 3
    ORDER BY total DESC, closed DESC, latest_created_at DESC
  `, [since]).catch(() => []);

  const rows = aggregateStrategyFeedbackOutcomeRows(rawRows.map(normalizeStrategyFeedbackOutcomeRow));
  const sampleContext = await loadStrategyFeedbackSampleContext(days, since);
  const decision = buildDecision(rows, sampleContext);
  const payload = {
    ok: true,
    days: Number(days),
    generatedAt: new Date().toISOString(),
    count: rows.length,
    rows,
    sampleContext,
    decision,
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildStrategyFeedbackOutcomes(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-strategy-feedback-outcomes 오류:',
  });
}
