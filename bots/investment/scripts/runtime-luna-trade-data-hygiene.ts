#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildTradeDataAnalysisReport } from '../shared/trade-data-analysis-report.ts';
import { close } from '../shared/db/core.ts';

function parseArgs(args = []) {
  const limitArg = args.find((arg) => arg.startsWith('--limit='))?.split('=')[1];
  return {
    json: args.includes('--json'),
    limit: Number.isFinite(Number(limitArg)) ? Number(limitArg) : 5000,
  };
}

export async function buildRuntimeTradeDataHygiene(options = {}) {
  const report = await buildTradeDataAnalysisReport({ limit: options.limit || 5000 });
  const status = report.hygiene?.status || 'unknown';
  const findings = Array.isArray(report.hygiene?.findings) ? report.hygiene.findings : [];
  return {
    ok: report.ok === true && status === 'ready',
    status,
    severity: report.hygiene?.severity || 'unknown',
    generatedAt: report.generatedAt,
    hygiene: report.hygiene,
    blockers: status === 'ready'
      ? []
      : findings.map((finding) => `trade_data_hygiene:${finding.id || finding.reason || 'finding'}`),
    coverage: {
      realizedPnl: report.trades?.realizedPnlCoverage || null,
      posttrade: report.posttrade?.qualityCoverage || null,
    },
    signalFailureRate: report.signals?.failureRate ?? null,
    warnings: report.warnings || [],
    nextActions: report.hygiene?.nextActions || [],
    analysisNextActions: report.nextActions || [],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  try {
    const result = await buildRuntimeTradeDataHygiene(options);
    if (options.json) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`trade-data-hygiene status=${result.status} severity=${result.severity}`);
      console.log(`findings=${result.hygiene?.findings?.length || 0} warnings=${result.warnings.length}`);
    }
    if (result.status !== 'ready') process.exitCode = 2;
  } finally {
    await Promise.resolve(close()).catch(() => {});
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'runtime-luna-trade-data-hygiene failed:' });
}
