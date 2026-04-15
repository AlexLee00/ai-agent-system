#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { reevaluateOpenPositions } from '../shared/position-reevaluator.ts';

function parseArgs(argv = []) {
  const args = {
    exchange: null,
    tradeMode: null,
    paper: false,
    persist: true,
    json: false,
    minutesBack: 180,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--paper') args.paper = true;
    else if (raw === '--no-persist') args.persist = false;
    else if (raw.startsWith('--exchange=')) args.exchange = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--trade-mode=')) args.tradeMode = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--minutes=')) args.minutesBack = Math.max(10, Number(raw.split('=').slice(1).join('=') || 180));
  }
  return args;
}

function renderText(report, args) {
  const lines = [
    '🔁 Position Reevaluation Report',
    `exchange: ${args.exchange || 'all'}`,
    `tradeMode: ${args.tradeMode || 'all'}`,
    `paper: ${args.paper}`,
    `positions: ${report.count}`,
    `persisted: ${report.persisted}`,
    `summary: HOLD ${report.summary.hold} / ADJUST ${report.summary.adjust} / EXIT ${report.summary.exit}`,
  ];

  for (const row of report.rows || []) {
    lines.push(
      `${row.exchange} | ${row.symbol} | ${row.tradeMode} | ${row.recommendation} | pnl=${Number(row.pnlPct || 0).toFixed(2)}% | reason=${row.reason}`,
    );
  }

  return lines.join('\n');
}

export async function buildPositionReevaluationReport(args = {}) {
  const report = await reevaluateOpenPositions(args);
  if (args.json) return report;
  return renderText(report, args);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await buildPositionReevaluationReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ position-reevaluation-report 오류:',
  });
}
