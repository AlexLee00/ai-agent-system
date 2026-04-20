#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeKisOrderPressureReport } from './runtime-kis-order-pressure-report.ts';

const DEFAULT_FILE = '/tmp/investment-runtime-kis-order-pressure-history.jsonl';

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
    '📚 Runtime KIS Order Pressure History',
    `file: ${payload.file}`,
    `snapshots: ${payload.historyCount}`,
    `current: ${payload.current.status}`,
    `previous: ${payload.previous?.status || 'none'}`,
    `count delta: ${payload.delta.count >= 0 ? '+' : ''}${payload.delta.count}`,
    `APBK0400 delta: ${payload.delta.apbk0400 >= 0 ? '+' : ''}${payload.delta.apbk0400}`,
    `APBK0952 delta: ${payload.delta.apbk0952 >= 0 ? '+' : ''}${payload.delta.apbk0952}`,
    '',
    `headline: ${payload.current.headline}`,
  ].join('\n');
}

export async function buildRuntimeKisOrderPressureHistory({ days = 14, file = DEFAULT_FILE, json = false } = {}) {
  const report = await buildRuntimeKisOrderPressureReport({ days, json: true });
  const current = {
    recordedAt: new Date().toISOString(),
    status: report.decision.status,
    headline: report.decision.headline,
    count: Number(report.count || 0),
    apbk0400: Number(report.decision?.metrics?.apbk0400 || 0),
    apbk0952: Number(report.decision?.metrics?.apbk0952 || 0),
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
      apbk0400: previous ? current.apbk0400 - Number(previous.apbk0400 || 0) : 0,
      apbk0952: previous ? current.apbk0952 - Number(previous.apbk0952 || 0) : 0,
    },
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeKisOrderPressureHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-kis-order-pressure-history 오류:',
  });
}
