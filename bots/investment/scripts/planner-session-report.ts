// @ts-nocheck
import * as db from '../shared/db.ts';
import { initPipelineSchema } from '../shared/pipeline-db.ts';

function parseArgs(argv = []) {
  const args = { market: 'all', limit: 10, json: false };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw.startsWith('--market=')) args.market = String(raw.split('=').slice(1).join('=') || 'all');
    else if (raw.startsWith('--limit=')) args.limit = Math.max(1, Number(raw.split('=').slice(1).join('=') || 10));
  }
  return args;
}

async function loadPlannerSessions({ market = 'all', limit = 10 } = {}) {
  await initPipelineSchema();
  let where = `meta->>'planner_mode' IS NOT NULL`;
  if (market !== 'all') {
    const safeMarket = String(market).replace(/'/g, "''");
    where += ` AND market = '${safeMarket}'`;
  }
  const safeLimit = Math.max(1, Number(limit || 10));

  const rows = await db.query(
    `SELECT
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
     LIMIT ${safeLimit}`,
  );

  return rows.map((row) => ({
    sessionId: row.session_id,
    market: row.market,
    status: row.status,
    startedAt: Number(row.started_at || 0),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    plannerMode: row.meta?.planner_mode || 'unknown',
    plannerTradeMode: row.meta?.planner_trade_mode || 'normal',
    plannerTimeMode: row.meta?.planner_time_mode || 'unknown',
    plannerResearchDepth: Number(row.meta?.planner_research_depth || 0),
    plannerShouldAnalyze: Boolean(row.meta?.planner_should_analyze),
    plannerSkipReason: row.meta?.planner_skip_reason || null,
    plannerResearchOnly: Boolean(row.meta?.planner_research_only),
    plannerSymbolCount: Number(row.meta?.planner_symbol_count || 0),
  }));
}

function renderTextReport(rows = [], args = {}) {
  const summary = buildSummary(rows);
  const lines = [
    `Planner sessions: ${rows.length}`,
    `market: ${args.market}`,
    `limit: ${args.limit}`,
    `byMarket: ${formatSummaryMap(summary.byMarket)}`,
    `byMode: ${formatSummaryMap(summary.byMode)}`,
  ];

  for (const row of rows) {
    lines.push(
      `${row.market} | ${row.status} | mode=${row.plannerMode} | trade=${row.plannerTradeMode} | time=${row.plannerTimeMode} | depth=${row.plannerResearchDepth} | analyze=${row.plannerShouldAnalyze ? 'yes' : 'no'}${row.plannerSkipReason ? ` | skip=${row.plannerSkipReason}` : ''} | symbols=${row.plannerSymbolCount}`,
    );
  }

  return lines.join('\n');
}

function buildSummary(rows = []) {
  const byMarket = {};
  const byMode = {};
  for (const row of rows) {
    byMarket[row.market] = (byMarket[row.market] || 0) + 1;
    byMode[row.plannerMode] = (byMode[row.plannerMode] || 0) + 1;
  }
  return { byMarket, byMode };
}

function formatSummaryMap(map = {}) {
  const entries = Object.entries(map);
  if (entries.length === 0) return 'none';
  return entries.map(([key, count]) => `${key}:${count}`).join(', ');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = await loadPlannerSessions(args);
  const payload = {
    ok: true,
    market: args.market,
    limit: args.limit,
    count: rows.length,
    summary: buildSummary(rows),
    sessions: rows,
  };

  if (args.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(renderTextReport(rows, args));
}

main().catch((error) => {
  const payload = {
    ok: false,
    error: error?.message || String(error),
  };
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.error(`planner-session-report failed: ${payload.error}`);
  }
  process.exitCode = 1;
});
