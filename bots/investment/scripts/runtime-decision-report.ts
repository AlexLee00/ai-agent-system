#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';
import { checkSafetyGates } from '../shared/signal.ts';

function parseArgs(argv = []) {
  const args = { market: 'all', limit: 5, json: false, includeSmoke: false };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--include-smoke') args.includeSmoke = true;
    else if (raw.startsWith('--market=')) args.market = String(raw.split('=').slice(1).join('=') || 'all');
    else if (raw.startsWith('--limit=')) args.limit = Math.max(1, Number(raw.split('=').slice(1).join('=') || 5));
  }
  return args;
}

function normalizeMarket(market = 'all') {
  const value = String(market || 'all').toLowerCase();
  if (value === 'crypto') return 'binance';
  if (value === 'domestic') return 'kis';
  if (value === 'overseas') return 'kis_overseas';
  return value;
}

async function loadRuntimeDecisions({ market = 'all', limit = 5, includeSmoke = false } = {}) {
  const normalizedMarket = normalizeMarket(market);
  let where = `pipeline = 'luna_pipeline' AND meta->>'bridge_status' IS NOT NULL`;
  if (!includeSmoke) {
    where += ` AND COALESCE(meta->>'smoke', 'false') != 'true'`;
    where += ` AND COALESCE(trigger_type, '') != 'smoke'`;
  }
  if (normalizedMarket !== 'all') {
    const safeMarket = String(normalizedMarket).replace(/'/g, "''");
    where += ` AND market = '${safeMarket}'`;
  }
  const safeLimit = Math.max(1, Number(limit || 5));

  const rows = await db.query(`
    SELECT
      session_id,
      market,
      status,
      started_at,
      finished_at,
      duration_ms,
      meta
    FROM pipeline_runs
    WHERE ${where}
    ORDER BY started_at DESC
    LIMIT ${safeLimit}
  `);

  return rows.map((row) => ({
    sessionId: row.session_id,
    market: row.market,
    status: row.status,
    startedAt: Number(row.started_at || 0),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    bridgeStatus: row.meta?.bridge_status || 'unknown',
    investmentTradeMode: row.meta?.investment_trade_mode || 'unknown',
    plannerMode: row.meta?.planner_mode || null,
    plannerTimeMode: row.meta?.planner_time_mode || null,
    plannerTradeMode: row.meta?.planner_trade_mode || null,
    approvedSignals: Number(row.meta?.approved_signals || 0),
    executedSymbols: Number(row.meta?.executed_symbols || 0),
    decisionCount: Number(row.meta?.decision_count || 0),
    debateCount: Number(row.meta?.debate_count || 0),
    debateLimit: Number(row.meta?.debate_limit || 0),
    riskRejected: Number(row.meta?.risk_rejected || 0),
    riskRejectReasonTop: row.meta?.risk_reject_reason_top || null,
    weakSignalSkipped: Number(row.meta?.weak_signal_skipped || 0),
    warnings: Array.isArray(row.meta?.warnings) ? row.meta.warnings : [],
  }));
}

async function loadRecentSignalOutcomeSummary({ market = 'all', hours = 6, since = null } = {}) {
  const normalizedMarket = normalizeMarket(market);
  let where = '';
  const params = [];
  if (since != null) {
    params.push(Number(since));
    where = `extract(epoch from created_at) * 1000 >= $${params.length}`;
  } else {
    where = `created_at >= now() - interval '${Math.max(1, Number(hours || 6))} hours'`;
  }
  if (normalizedMarket !== 'all') {
    const safeMarket = String(normalizedMarket).replace(/'/g, "''");
    where += ` AND exchange = '${safeMarket}'`;
  }

  const rows = await db.query(`
    SELECT
      status,
      block_code,
      COUNT(*)::int AS count
    FROM signals
    WHERE ${where}
    GROUP BY status, block_code
    ORDER BY count DESC, status ASC
  `, params);

  const summary = {
    total: 0,
    executed: 0,
    blocked: 0,
    failed: 0,
    topBlockCode: null,
    topBlockCount: 0,
    rows: [],
  };

  for (const row of rows) {
    const count = Number(row.count || 0);
    const status = String(row.status || 'unknown');
    const blockCode = row.block_code || null;
    summary.total += count;
    if (status === 'executed') summary.executed += count;
    else if (status === 'blocked') summary.blocked += count;
    else if (status === 'failed') summary.failed += count;
    if (blockCode && count > summary.topBlockCount) {
      summary.topBlockCode = blockCode;
      summary.topBlockCount = count;
    }
    summary.rows.push({
      status,
      blockCode,
      count,
    });
  }

  return summary;
}

async function loadRecentBlockedSignalReview({ market = 'all', since = null, limit = 12 } = {}) {
  const normalizedMarket = normalizeMarket(market);
  const params = [];
  let where = `status = 'blocked' AND block_code = 'safety_gate_blocked'`;
  if (since != null) {
    params.push(Number(since));
    where += ` AND extract(epoch from created_at) * 1000 >= $${params.length}`;
  }
  if (normalizedMarket !== 'all') {
    params.push(String(normalizedMarket));
    where += ` AND exchange = $${params.length}`;
  }
  params.push(Math.max(1, Number(limit || 12)));

  const rows = await db.query(`
    SELECT
      id,
      symbol,
      exchange,
      trade_mode,
      action,
      amount_usdt,
      confidence,
      block_reason,
      created_at
    FROM signals
    WHERE ${where}
    ORDER BY created_at DESC
    LIMIT $${params.length}
  `, params);

  const reviewRows = [];
  for (const row of rows) {
    try {
      const replay = await checkSafetyGates({
        symbol: row.symbol,
        exchange: row.exchange,
        trade_mode: row.trade_mode,
        action: row.action,
        amount_usdt: Number(row.amount_usdt || 0),
        amountUsdt: Number(row.amount_usdt || 0),
        confidence: Number(row.confidence || 0),
      });
      reviewRows.push({
        id: row.id,
        symbol: row.symbol,
        exchange: row.exchange,
        tradeMode: row.trade_mode,
        originalReason: row.block_reason,
        currentPassed: Boolean(replay?.passed),
        currentSoftened: Boolean(replay?.softened),
        currentReason: replay?.reason || replay?.advisoryReason || null,
        createdAt: row.created_at,
      });
    } catch (error) {
      reviewRows.push({
        id: row.id,
        symbol: row.symbol,
        exchange: row.exchange,
        tradeMode: row.trade_mode,
        originalReason: row.block_reason,
        currentPassed: false,
        currentSoftened: false,
        currentReason: `recheck_failed:${error.message}`,
        createdAt: row.created_at,
      });
    }
  }

  const active = reviewRows.filter((row) => !row.currentPassed);
  const resolved = reviewRows.filter((row) => row.currentPassed);
  const topActiveReason = active[0]?.currentReason || null;

  return {
    total: reviewRows.length,
    activeCount: active.length,
    resolvedCount: resolved.length,
    topActiveReason,
    rows: reviewRows,
  };
}

function buildSummary(rows = []) {
  const byMarket = {};
  let approvedSignals = 0;
  let executedSymbols = 0;
  let riskRejected = 0;
  const warningSet = new Set();

  for (const row of rows) {
    byMarket[row.market] = (byMarket[row.market] || 0) + 1;
    approvedSignals += row.approvedSignals;
    executedSymbols += row.executedSymbols;
    riskRejected += row.riskRejected;
    for (const warning of row.warnings || []) warningSet.add(warning);
  }

  return {
    byMarket,
    approvedSignals,
    executedSymbols,
    riskRejected,
    warnings: [...warningSet],
  };
}

function formatMap(map = {}) {
  const entries = Object.entries(map);
  if (entries.length === 0) return 'none';
  return entries.map(([k, v]) => `${k}:${v}`).join(', ');
}

function renderText(rows = [], args = {}) {
  const summary = buildSummary(rows);
  const signalOutcomes = args.signalOutcomes || {};
  const blockedReview = args.blockedReview || {};
  const lines = [
    `Runtime decision sessions: ${rows.length}`,
    `market: ${args.market}`,
    `limit: ${args.limit}`,
    args.aiSummary ? `🔍 AI: ${args.aiSummary}` : null,
    `byMarket: ${formatMap(summary.byMarket)}`,
    `approvedSignals: ${summary.approvedSignals}`,
    `executedSymbols: ${summary.executedSymbols}`,
    `riskRejected: ${summary.riskRejected}`,
    `warnings: ${summary.warnings.join(', ') || 'none'}`,
    `signalOutcomes: executed=${signalOutcomes.executed || 0}, blocked=${signalOutcomes.blocked || 0}, failed=${signalOutcomes.failed || 0}${signalOutcomes.topBlockCode ? ` | topBlock=${signalOutcomes.topBlockCode}:${signalOutcomes.topBlockCount || 0}` : ''}`,
    `blockedReview: active=${blockedReview.activeCount || 0}, resolved=${blockedReview.resolvedCount || 0}${blockedReview.topActiveReason ? ` | topActive=${blockedReview.topActiveReason}` : ''}`,
  ];

  for (const row of rows) {
    lines.push(
      `${row.market} | ${row.bridgeStatus} | trade=${row.investmentTradeMode} | approved=${row.approvedSignals} | executed=${row.executedSymbols} | decisions=${row.decisionCount} | debate=${row.debateCount}/${row.debateLimit} | riskRejected=${row.riskRejected}${row.riskRejectReasonTop ? ` | topRisk=${row.riskRejectReasonTop}` : ''}${row.plannerMode ? ` | planner=${row.plannerMode}` : ''}${row.plannerTimeMode ? ` | time=${row.plannerTimeMode}` : ''}`,
    );
  }

  return lines.filter(Boolean).join('\n');
}

function buildRuntimeDecisionFallback(payload = {}) {
  const summary = payload.summary || {};
  const signalOutcomes = payload.signalOutcomes || {};
  const blockedReview = payload.blockedReview || {};
  const warnings = Array.isArray(summary.warnings) ? summary.warnings : [];
  if ((payload.count || 0) === 0) {
    return '최근 runtime decision 세션 표본이 없어 먼저 세션 누적 상태를 확인하는 것이 좋습니다.';
  }
  if ((summary.approvedSignals || 0) > 0 && (summary.executedSymbols || 0) === 0) {
    if ((blockedReview.activeCount || 0) > 0 && blockedReview.topActiveReason) {
      return `최근 runtime decision ${payload.count || 0}건에서 approved ${summary.approvedSignals || 0}건이 있었지만 executed는 0건이고, 현재 코드로 다시 확인해도 살아 있는 차단은 ${blockedReview.topActiveReason} 쪽이라 승인 이후 활성 safety gate를 먼저 줄이는 편이 좋습니다.`;
    }
    if ((blockedReview.total || 0) > 0 && (blockedReview.activeCount || 0) === 0) {
      return `최근 runtime decision ${payload.count || 0}건에서 approved ${summary.approvedSignals || 0}건이 있었지만 executed는 0건이고, 최신 safety gate 차단 ${blockedReview.total || 0}건은 현재 코드로 다시 확인하면 모두 통과합니다. 즉 지금은 활성 safety gate보다 실행 후속 경로나 체결 집계 드리프트를 먼저 점검하는 편이 좋습니다.`;
    }
    if ((signalOutcomes.blocked || 0) > 0 && signalOutcomes.topBlockCode) {
      return `최근 runtime decision ${payload.count || 0}건에서 approved ${summary.approvedSignals || 0}건이 있었지만 executed는 0건이고, 최신 signals는 ${signalOutcomes.topBlockCode} 차단이 ${signalOutcomes.topBlockCount || 0}건으로 가장 많아 승인 이후 safety gate를 먼저 점검하는 편이 좋습니다.`;
    }
    return `최근 runtime decision ${payload.count || 0}건에서 approved ${summary.approvedSignals || 0}건이 있었지만 executed는 0건이라, 승인 이후 safety gate·브로커 실행·체결 집계 경로를 먼저 점검하는 편이 좋습니다.`;
  }
  if ((summary.riskRejected || 0) > 0) {
    return `최근 runtime decision ${payload.count || 0}건 중 risk reject가 ${summary.riskRejected || 0}건 보여, 상위 reject 사유를 먼저 점검하는 편이 좋습니다.`;
  }
  if (warnings.length > 0) {
    return `최근 runtime decision ${payload.count || 0}건은 실행됐지만 경고 ${warnings.length}종이 있어 bridge 상태를 함께 보는 것이 좋습니다.`;
  }
  return `최근 runtime decision ${payload.count || 0}건은 approved ${summary.approvedSignals || 0}, executed ${summary.executedSymbols || 0} 기준으로 비교적 안정적입니다.`;
}

export async function buildRuntimeDecisionReport({ market = 'all', limit = 5, json = false, includeSmoke = false } = {}) {
  const normalizedMarket = normalizeMarket(market);
  const rows = await loadRuntimeDecisions({ market: normalizedMarket, limit, includeSmoke });
  const startedAtValues = rows
    .map((row) => Number(row.startedAt || 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  const signalWindowSince = startedAtValues.length > 0 ? Math.min(...startedAtValues) : null;
  const [signalOutcomes, blockedReview] = await Promise.all([
    loadRecentSignalOutcomeSummary({
      market: normalizedMarket,
      hours: 6,
      since: signalWindowSince,
    }),
    loadRecentBlockedSignalReview({
      market: normalizedMarket,
      since: signalWindowSince,
      limit: 12,
    }),
  ]);
  const payload = {
    ok: true,
    market: normalizedMarket,
    limit,
    includeSmoke,
    count: rows.length,
    summary: buildSummary(rows),
    signalOutcomes,
    blockedReview,
    rows,
  };
  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-decision-report',
    requestType: 'runtime-decision-report',
    title: '투자 runtime decision 리포트 요약',
    data: {
      market: normalizedMarket,
      limit,
      includeSmoke,
      count: rows.length,
      summary: payload.summary,
      signalOutcomes,
      blockedReview,
      signalWindowSince,
      topRows: rows.slice(0, 5),
    },
    fallback: buildRuntimeDecisionFallback(payload),
  });

  if (json) return payload;
  return renderText(rows, { market: normalizedMarket, limit, aiSummary: payload.aiSummary, signalOutcomes, blockedReview });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildRuntimeDecisionReport(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(report);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-decision-report 오류:',
  });
}
