#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeKisReentryPressureReport } from './runtime-kis-reentry-pressure-report.ts';

const DEFAULT_FILE = '/tmp/investment-runtime-kis-reentry-pressure-history.jsonl';

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
    '📚 Runtime KIS Reentry Pressure History',
    `file: ${payload.file}`,
    `snapshots: ${payload.historyCount}`,
    `current: ${payload.current.status}`,
    `previous: ${payload.previous?.status || 'none'}`,
    `count delta: ${payload.delta.count >= 0 ? '+' : ''}${payload.delta.count}`,
    `live delta: ${payload.delta.live >= 0 ? '+' : ''}${payload.delta.live}`,
    `sameDay delta: ${payload.delta.sameDay >= 0 ? '+' : ''}${payload.delta.sameDay}`,
    '',
    `headline: ${payload.current.headline}`,
  ].join('\n');
}

export async function buildRuntimeKisReentryPressureHistory({ days = 14, file = DEFAULT_FILE, json = false } = {}) {
  const report = await buildRuntimeKisReentryPressureReport({ days, json: true });
  const current = {
    recordedAt: new Date().toISOString(),
    status: report.decision.status,
    headline: report.decision.headline,
    count: Number(report.count || 0),
    live: Number(report.decision?.metrics?.live || 0),
    paper: Number(report.decision?.metrics?.paper || 0),
    sameDay: Number(report.decision?.metrics?.sameDay || 0),
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
      live: previous ? current.live - Number(previous.live || 0) : 0,
      paper: previous ? current.paper - Number(previous.paper || 0) : 0,
      sameDay: previous ? current.sameDay - Number(previous.sameDay || 0) : 0,
    },
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeKisReentryPressureHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-kis-reentry-pressure-history 오류:',
  });
}
