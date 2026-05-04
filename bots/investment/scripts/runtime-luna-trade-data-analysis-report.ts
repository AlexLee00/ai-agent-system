#!/usr/bin/env node
// @ts-nocheck
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildTradeDataAnalysisReport } from '../shared/trade-data-analysis-report.ts';
import { close } from '../shared/db/core.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const limit = Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || 5000);
  return {
    json: argv.includes('--json'),
    smoke: argv.includes('--smoke'),
    limit: Number.isFinite(limit) && limit > 0 ? limit : 5000,
  };
}

export async function runReport(args = parseArgs()) {
  const report = await buildTradeDataAnalysisReport({ limit: args.smoke ? 200 : args.limit });
  return {
    ...report,
    source: args.smoke ? 'smoke_db_sample' : 'db',
  };
}

async function main() {
  const args = parseArgs();
  try {
    const report = await runReport(args);
    if (args.json) console.log(JSON.stringify(report, null, 2));
    else console.log(`runtime-luna-trade-data-analysis-report status=${report.status} signals=${report.signals.total}`);
  } finally {
    await Promise.resolve(close()).catch(() => {});
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-luna-trade-data-analysis-report 실패:' });
}
