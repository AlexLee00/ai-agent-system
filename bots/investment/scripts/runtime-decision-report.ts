#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = []) {
  const args = { market: 'all', limit: 5, json: false };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw.startsWith('--market=')) args.market = String(raw.split('=').slice(1).join('=') || 'all');
    else if (raw.startsWith('--limit=')) args.limit = Math.max(1, Number(raw.split('=').slice(1).join('=') || 5));
  }
  return args;
}

async function loadRuntimeDecisions({ market = 'all', limit = 5 } = {}) {
  let where = `pipeline = 'luna_pipeline' AND meta->>'bridge_status' IS NOT NULL`;
  if (market !== 'all') {
    const safeMarket = String(market).replace(/'/g, "''");
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

  return lines.join('\n');
}

export async function buildRuntimeDecisionReport({ market = 'all', limit = 5, json = false } = {}) {
  const rows = await loadRuntimeDecisions({ market, limit });
  const payload = {
    ok: true,
    market,
    limit,
    count: rows.length,
    summary: buildSummary(rows),
    rows,
  };

  if (json) return payload;
  return renderText(rows, { market, limit });
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
