#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const DEFAULT_OUTPUT = path.resolve('output/dashboard/trade-journal.html');

function buildFixtureRows() {
  return [
    { day: '2026-04-28', market: 'binance', trades: 3, pnl: 12.4, success: 0.67, failure: 'late_exit' },
    { day: '2026-04-29', market: 'kis', trades: 0, pnl: 0, success: 0, failure: 'none' },
    { day: '2026-04-30', market: 'binance', trades: 2, pnl: -3.1, success: 0.5, failure: 'guardrail_block' },
  ];
}

export function buildTradeJournalDashboard(rows = buildFixtureRows()) {
  const totalTrades = rows.reduce((sum, row) => sum + Number(row.trades || 0), 0);
  const totalPnl = rows.reduce((sum, row) => sum + Number(row.pnl || 0), 0);
  const failures = {};
  for (const row of rows) failures[row.failure] = (failures[row.failure] || 0) + 1;
  const tableRows = rows.map((row) => `<tr><td>${row.day}</td><td>${row.market}</td><td>${row.trades}</td><td>${row.pnl}</td><td>${row.success}</td><td>${row.failure}</td></tr>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Luna Trade Journal</title><style>body{font-family:system-ui,sans-serif;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:6px 10px}</style></head><body><h1>Luna Trade Journal Dashboard</h1><p>Total trades: ${totalTrades}</p><p>Total PnL: ${totalPnl.toFixed(2)}</p><h2>Failure Top</h2><pre>${JSON.stringify(failures, null, 2)}</pre><table><thead><tr><th>Day</th><th>Market</th><th>Trades</th><th>PnL</th><th>Success</th><th>Failure</th></tr></thead><tbody>${tableRows}</tbody></table></body></html>`;
  return { ok: true, totalTrades, totalPnl, failures, html };
}

export async function writeTradeJournalDashboard({ output = DEFAULT_OUTPUT, write = true } = {}) {
  const dashboard = buildTradeJournalDashboard();
  if (write) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, dashboard.html);
  }
  return { ...dashboard, output: write ? output : null, html: undefined };
}

async function main() {
  const result = await writeTradeJournalDashboard({ write: !process.argv.includes('--no-write') });
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`runtime-trade-journal-dashboard-html ok trades=${result.totalTrades}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-trade-journal-dashboard-html 실패:' });
}
