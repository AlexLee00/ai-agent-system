#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';

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
  const warnings = Array.isArray(summary.warnings) ? summary.warnings : [];
  if ((payload.count || 0) === 0) {
    return '최근 runtime decision 세션 표본이 없어 먼저 세션 누적 상태를 확인하는 것이 좋습니다.';
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
  const payload = {
    ok: true,
    market: normalizedMarket,
    limit,
    includeSmoke,
    count: rows.length,
    summary: buildSummary(rows),
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
      topRows: rows.slice(0, 5),
    },
    fallback: buildRuntimeDecisionFallback(payload),
  });

  if (json) return payload;
  return renderText(rows, { market: normalizedMarket, limit, aiSummary: payload.aiSummary });
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
