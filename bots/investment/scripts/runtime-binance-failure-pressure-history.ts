#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeBinanceFailurePressureReport } from './runtime-binance-failure-pressure-report.ts';

const DEFAULT_FILE = '/tmp/investment-runtime-binance-failure-pressure-history.jsonl';

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
    '📚 Runtime Binance Failure Pressure History',
    `file: ${payload.file}`,
    `snapshots: ${payload.historyCount}`,
    `current: ${payload.current.status}`,
    `previous: ${payload.previous?.status || 'none'}`,
    `count delta: ${payload.delta.count >= 0 ? '+' : ''}${payload.delta.count}`,
    `circuit delta: ${payload.delta.circuitBreaker >= 0 ? '+' : ''}${payload.delta.circuitBreaker}`,
    `guard delta: ${payload.delta.capitalGuard >= 0 ? '+' : ''}${payload.delta.capitalGuard}`,
    `reentry delta: ${payload.delta.reentry >= 0 ? '+' : ''}${payload.delta.reentry}`,
    '',
    `headline: ${payload.current.headline}`,
  ].join('\n');
}

export async function buildRuntimeBinanceFailurePressureHistory({ days = 14, file = DEFAULT_FILE, json = false } = {}) {
  const report = await buildRuntimeBinanceFailurePressureReport({ days, json: true });
  const current = {
    recordedAt: new Date().toISOString(),
    status: report.decision.status,
    headline: report.decision.headline,
    count: Number(report.count || 0),
    circuitBreaker: Number(report.decision?.metrics?.circuitBreaker || 0),
    capitalGuard: Number(report.decision?.metrics?.capitalGuard || 0),
    reentry: Number(report.decision?.metrics?.reentry || 0),
    precision: Number(report.decision?.metrics?.precision || 0),
    insufficientBalance: Number(report.decision?.metrics?.insufficientBalance || 0),
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
      circuitBreaker: previous ? current.circuitBreaker - Number(previous.circuitBreaker || 0) : 0,
      capitalGuard: previous ? current.capitalGuard - Number(previous.capitalGuard || 0) : 0,
      reentry: previous ? current.reentry - Number(previous.reentry || 0) : 0,
      precision: previous ? current.precision - Number(previous.precision || 0) : 0,
      insufficientBalance: previous ? current.insufficientBalance - Number(previous.insufficientBalance || 0) : 0,
    },
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeBinanceFailurePressureHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-binance-failure-pressure-history 오류:',
  });
}
