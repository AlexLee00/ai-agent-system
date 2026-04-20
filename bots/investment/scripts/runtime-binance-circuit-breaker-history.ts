#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeBinanceCircuitBreakerReport } from './runtime-binance-circuit-breaker-report.ts';

const DEFAULT_FILE = '/tmp/investment-runtime-binance-circuit-breaker-history.jsonl';

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
    '📚 Runtime Binance Circuit Breaker History',
    `file: ${payload.file}`,
    `snapshots: ${payload.historyCount}`,
    `current: ${payload.current.status}`,
    `previous: ${payload.previous?.status || 'none'}`,
    `count delta: ${payload.delta.count >= 0 ? '+' : ''}${payload.delta.count}`,
    `normal delta: ${payload.delta.normal >= 0 ? '+' : ''}${payload.delta.normal}`,
    `validation delta: ${payload.delta.validation >= 0 ? '+' : ''}${payload.delta.validation}`,
    '',
    `headline: ${payload.current.headline}`,
  ].join('\n');
}

export async function buildRuntimeBinanceCircuitBreakerHistory({ days = 14, file = DEFAULT_FILE, json = false } = {}) {
  const report = await buildRuntimeBinanceCircuitBreakerReport({ days, json: true });
  const current = {
    recordedAt: new Date().toISOString(),
    status: report.decision.status,
    headline: report.decision.headline,
    count: Number(report.count || 0),
    normal: Number(report.decision?.metrics?.normal || 0),
    validation: Number(report.decision?.metrics?.validation || 0),
    topSymbol: report.decision?.metrics?.topSymbol || null,
    topSymbolCount: Number(report.decision?.metrics?.topSymbolCount || 0),
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
      normal: previous ? current.normal - Number(previous.normal || 0) : 0,
      validation: previous ? current.validation - Number(previous.validation || 0) : 0,
      topSymbolCount: previous ? current.topSymbolCount - Number(previous.topSymbolCount || 0) : 0,
    },
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeBinanceCircuitBreakerHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-binance-circuit-breaker-history 오류:',
  });
}
