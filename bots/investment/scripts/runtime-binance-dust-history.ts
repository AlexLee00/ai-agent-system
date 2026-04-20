#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeBinanceDustReport } from './runtime-binance-dust-report.ts';

const DEFAULT_MAX_USDT = 10;
const DEFAULT_FILE = '/tmp/investment-runtime-binance-dust-history.jsonl';

function parseArgs(argv = process.argv.slice(2)) {
  const maxUsdtArg = argv.find((arg) => arg.startsWith('--max-usdt='));
  const fileArg = argv.find((arg) => arg.startsWith('--file='));
  return {
    maxUsdt: Math.max(0.1, Number(maxUsdtArg?.split('=')[1] || DEFAULT_MAX_USDT)),
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
    '📚 Runtime Binance Dust History',
    `file: ${payload.file}`,
    `snapshots: ${payload.historyCount}`,
    `current: ${payload.current.status}`,
    `previous: ${payload.previous?.status || 'none'}`,
    `unresolved delta: ${payload.delta.unresolvedCount >= 0 ? '+' : ''}${payload.delta.unresolvedCount}`,
    `unresolved usdt delta: ${payload.delta.unresolvedTotalUsdt >= 0 ? '+' : ''}${payload.delta.unresolvedTotalUsdt.toFixed(6)}`,
    `actionable delta: ${payload.delta.actionableCount >= 0 ? '+' : ''}${payload.delta.actionableCount}`,
    '',
    `headline: ${payload.current.headline}`,
  ].join('\n');
}

export async function buildRuntimeBinanceDustHistory({ maxUsdt = DEFAULT_MAX_USDT, file = DEFAULT_FILE, json = false } = {}) {
  const report = await buildRuntimeBinanceDustReport({ maxUsdt, json: true });
  const current = {
    recordedAt: new Date().toISOString(),
    status: report.decision.status,
    headline: report.decision.headline,
    unresolvedCount: Number(report.snapshot?.unresolvedCount || 0),
    unresolvedTotalUsdt: Number(report.snapshot?.unresolvedTotalUsdt || 0),
    actionableCount: Number(report.snapshot?.actionableCount || 0),
    actionableTotalUsdt: Number(report.snapshot?.actionableTotalUsdt || 0),
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
      unresolvedCount: previous ? current.unresolvedCount - Number(previous.unresolvedCount || 0) : 0,
      unresolvedTotalUsdt: previous ? current.unresolvedTotalUsdt - Number(previous.unresolvedTotalUsdt || 0) : 0,
      actionableCount: previous ? current.actionableCount - Number(previous.actionableCount || 0) : 0,
      actionableTotalUsdt: previous ? current.actionableTotalUsdt - Number(previous.actionableTotalUsdt || 0) : 0,
    },
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeBinanceDustHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-binance-dust-history 오류:',
  });
}
