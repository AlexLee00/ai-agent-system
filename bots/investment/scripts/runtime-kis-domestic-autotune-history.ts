#!/usr/bin/env node
// @ts-nocheck

import { appendFileSync } from 'fs';
import { buildRuntimeKisDomesticAutotuneReport } from './runtime-kis-domestic-autotune-report.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const HISTORY_PATH = '/tmp/investment-runtime-kis-domestic-autotune-history.jsonl';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(1, Number(daysArg?.split('=')[1] || 14)),
    json: argv.includes('--json'),
  };
}

export async function buildRuntimeKisDomesticAutotuneHistory({ days = 14, json = false } = {}) {
  const report = await buildRuntimeKisDomesticAutotuneReport({ days, json: true });
  const snapshot = {
    capturedAt: new Date().toISOString(),
    days,
    status: report?.decision?.status || 'unknown',
    headline: report?.decision?.headline || '',
    totalBuy: Number(report?.decision?.metrics?.totalBuy || 0),
    executedSignals: Number(report?.decision?.metrics?.executedSignals || 0),
    failedSignals: Number(report?.decision?.metrics?.failedSignals || 0),
    executionRate: Number(report?.decision?.metrics?.executionRate || 0),
    realBuyTrades: Number(report?.decision?.metrics?.realBuyTrades || 0),
    orderPressureStatus: report?.decision?.metrics?.orderPressureStatus || null,
    orderPressureTotal: Number(report?.decision?.metrics?.orderPressureTotal || 0),
    validationRule1Blocks: Number(report?.decision?.metrics?.validationRule1Blocks || 0),
    candidateKey: report?.candidate?.key || null,
    candidateCurrent: report?.candidate?.current ?? null,
    candidateSuggested: report?.candidate?.suggested ?? null,
  };
  appendFileSync(HISTORY_PATH, `${JSON.stringify(snapshot)}\n`, 'utf8');
  const payload = { ok: true, historyPath: HISTORY_PATH, snapshot };
  if (json) return payload;
  return [
    '🧾 Runtime KIS Domestic Autotune History',
    `status: ${snapshot.status}`,
    `history: ${HISTORY_PATH}`,
    `BUY ${snapshot.totalBuy}건 | 실행률 ${snapshot.executionRate}% | 후보 ${snapshot.candidateKey || '없음'}`,
  ].join('\n');
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeKisDomesticAutotuneHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-kis-domestic-autotune-history 오류:',
  });
}
