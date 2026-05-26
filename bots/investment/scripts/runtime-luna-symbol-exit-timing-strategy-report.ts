#!/usr/bin/env node
// @ts-nocheck
import fs from 'node:fs';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { close } from '../shared/db/core.ts';
import { buildLunaSymbolExitTimingStrategyReport } from '../shared/luna-symbol-exit-timing-strategy.ts';
import { runOptimalExitAnalysis } from './runtime-luna-optimal-exit-analysis.ts';

const DEFAULT_OUTPUT = path.resolve('output/reports/luna-symbol-exit-timing-strategy-report.json');

function parseArgs(argv = process.argv.slice(2)) {
  const limit = Number(argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1] || '5000');
  const concurrency = Number(argv.find((arg) => arg.startsWith('--concurrency='))?.split('=')[1] || '5');
  return {
    json: argv.includes('--json'),
    smoke: argv.includes('--smoke'),
    noWrite: argv.includes('--no-write'),
    output: argv.find((arg) => arg.startsWith('--output='))?.split('=').slice(1).join('=') || DEFAULT_OUTPUT,
    limit: Number.isFinite(limit) && limit > 0 ? limit : 5000,
    concurrency: Number.isFinite(concurrency) && concurrency > 0 ? concurrency : 5,
  };
}

export async function runReport(args = parseArgs()) {
  const optimalExitReport = await runOptimalExitAnalysis({
    smoke: args.smoke,
    noWrite: true,
    json: true,
    limit: args.smoke ? 100 : args.limit,
    concurrency: args.smoke ? 1 : args.concurrency,
    includeRecords: true,
  });
  const report = buildLunaSymbolExitTimingStrategyReport({
    optimalExitReport,
    generatedAt: new Date().toISOString(),
    source: args.smoke ? 'smoke_fixture' : 'db_and_public_market_data',
  });
  const result = {
    ...report,
    output: args.noWrite ? null : args.output,
  };
  if (!args.noWrite) {
    fs.mkdirSync(path.dirname(args.output), { recursive: true });
    fs.writeFileSync(args.output, JSON.stringify(result, null, 2));
  }
  return result;
}

async function main() {
  const args = parseArgs();
  try {
    const result = await runReport(args);
    if (args.json) console.log(JSON.stringify(result, null, 2));
    else console.log(`runtime-luna-symbol-exit-timing-strategy-report status=${result.status} symbols=${result.scope.symbols}`);
  } finally {
    await Promise.resolve(close()).catch(() => {});
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'runtime-luna-symbol-exit-timing-strategy-report error:' });
}
