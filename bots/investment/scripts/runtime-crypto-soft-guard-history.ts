#!/usr/bin/env node
// @ts-nocheck

import { appendFileSync } from 'fs';
import { buildRuntimeCryptoSoftGuardReport } from './runtime-crypto-soft-guard-report.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const HISTORY_PATH = '/tmp/investment-runtime-crypto-soft-guard-history.jsonl';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(1, Number(daysArg?.split('=')[1] || 14)),
    json: argv.includes('--json'),
  };
}

export async function buildRuntimeCryptoSoftGuardHistory({ days = 14, json = false } = {}) {
  const report = await buildRuntimeCryptoSoftGuardReport({ days, json: true });
  const snapshot = {
    capturedAt: new Date().toISOString(),
    days,
    status: report?.decision?.status || 'unknown',
    headline: report?.decision?.headline || '',
    total: Number(report?.decision?.metrics?.total || 0),
    avgReductionMultiplier: Number(report?.decision?.metrics?.avgReductionMultiplier || 1),
    strongestReductionMultiplier: Number(report?.decision?.metrics?.strongestReductionMultiplier || 1),
    topKind: report?.decision?.metrics?.topKind || null,
    topKindCount: Number(report?.decision?.metrics?.topKindCount || 0),
    topSymbol: report?.decision?.metrics?.topSymbol || null,
    topSymbolCount: Number(report?.decision?.metrics?.topSymbolCount || 0),
  };
  appendFileSync(HISTORY_PATH, `${JSON.stringify(snapshot)}\n`, 'utf8');

  const payload = {
    ok: true,
    historyPath: HISTORY_PATH,
    snapshot,
  };
  if (json) return payload;
  return [
    '🧾 Runtime Crypto Soft Guard History',
    `status: ${snapshot.status}`,
    `history: ${HISTORY_PATH}`,
    `soft guard 실행 ${snapshot.total}건 | 평균 감산 x${snapshot.avgReductionMultiplier.toFixed(2)}`,
  ].join('\n');
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeCryptoSoftGuardHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-crypto-soft-guard-history 오류:',
  });
}
