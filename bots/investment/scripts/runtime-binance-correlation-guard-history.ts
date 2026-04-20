#!/usr/bin/env node
// @ts-nocheck

import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeBinanceCorrelationGuardReport } from './runtime-binance-correlation-guard-report.ts';

const DEFAULT_PATH = '/tmp/investment-runtime-binance-correlation-guard-history.jsonl';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const pathArg = argv.find((arg) => arg.startsWith('--path='));
  return {
    days: Math.max(1, Number(daysArg?.split('=')[1] || 14)),
    path: pathArg?.split('=')[1] || DEFAULT_PATH,
    json: argv.includes('--json'),
  };
}

function readLast(path) {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
}

export async function buildRuntimeBinanceCorrelationGuardHistory({ days = 14, path = DEFAULT_PATH, json = false } = {}) {
  const report = await buildRuntimeBinanceCorrelationGuardReport({ days, json: true });
  const previous = readLast(path);
  const snapshot = {
    capturedAt: new Date().toISOString(),
    status: report.decision.status,
    total: Number(report.summary?.total || 0),
    topTradeMode: report.decision.metrics?.topTradeMode || null,
    topTradeModeCount: Number(report.decision.metrics?.topTradeModeCount || 0),
    topSymbol: report.decision.metrics?.topSymbol || null,
    topSymbolCount: Number(report.decision.metrics?.topSymbolCount || 0),
    totalDelta: previous ? Number(report.summary?.total || 0) - Number(previous.total || 0) : 0,
  };

  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(snapshot)}\n`);

  const payload = {
    ok: true,
    path,
    snapshot,
    previous,
  };

  if (json) return payload;
  return [
    '🔗 Runtime Binance Correlation Guard History',
    `status: ${snapshot.status}`,
    `total: ${snapshot.total} (${snapshot.totalDelta >= 0 ? '+' : ''}${snapshot.totalDelta})`,
    `top trade mode: ${snapshot.topTradeMode || 'none'} (${snapshot.topTradeModeCount})`,
    `top symbol: ${snapshot.topSymbol || 'none'} (${snapshot.topSymbolCount})`,
    `path: ${path}`,
  ].join('\n');
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeBinanceCorrelationGuardHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-binance-correlation-guard-history 오류:',
  });
}
