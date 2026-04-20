#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeBinanceCapitalGuardReport } from './runtime-binance-capital-guard-report.ts';

const DEFAULT_FILE = '/tmp/investment-runtime-binance-capital-guard-history.jsonl';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const fileArg = argv.find((arg) => arg.startsWith('--file='));
  return {
    days: Math.max(1, Number(daysArg?.split('=')[1] || 14)),
    file: fileArg?.split('=').slice(1).join('=') || DEFAULT_FILE,
    json: argv.includes('--json'),
  };
}

function readHistory(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function appendHistory(file, snapshot) {
  fs.appendFileSync(file, `${JSON.stringify(snapshot)}\n`, 'utf8');
}

function renderText(payload) {
  return [
    '📚 Runtime Binance Capital Guard History',
    `file: ${payload.file}`,
    `snapshots: ${payload.historyCount}`,
    `current: ${payload.current.status}`,
    `previous: ${payload.previous?.status || 'none'}`,
    `count delta: ${payload.delta.count >= 0 ? '+' : ''}${payload.delta.count}`,
    `correlation delta: ${payload.delta.correlationGuard >= 0 ? '+' : ''}${payload.delta.correlationGuard}`,
    `daily trade limit delta: ${payload.delta.dailyTradeLimit >= 0 ? '+' : ''}${payload.delta.dailyTradeLimit}`,
    '',
    `headline: ${payload.current.headline}`,
  ].join('\n');
}

export async function buildRuntimeBinanceCapitalGuardHistory({ days = 14, file = DEFAULT_FILE, json = false } = {}) {
  const report = await buildRuntimeBinanceCapitalGuardReport({ days, json: true });
  const current = {
    recordedAt: new Date().toISOString(),
    status: report.decision.status,
    headline: report.decision.headline,
    count: Number(report.count || 0),
    correlationGuard: Number(report.decision?.metrics?.correlationGuard || 0),
    dailyTradeLimit: Number(report.decision?.metrics?.dailyTradeLimit || 0),
    maxPositions: Number(report.decision?.metrics?.maxPositions || 0),
  };
  const history = readHistory(file);
  const previous = history[history.length - 1] || null;
  appendHistory(file, current);
  const payload = {
    ok: true,
    file,
    historyCount: history.length + 1,
    current,
    previous,
    delta: {
      count: previous ? current.count - Number(previous.count || 0) : 0,
      correlationGuard: previous ? current.correlationGuard - Number(previous.correlationGuard || 0) : 0,
      dailyTradeLimit: previous ? current.dailyTradeLimit - Number(previous.dailyTradeLimit || 0) : 0,
      maxPositions: previous ? current.maxPositions - Number(previous.maxPositions || 0) : 0,
    },
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeBinanceCapitalGuardHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-binance-capital-guard-history 오류:',
  });
}
