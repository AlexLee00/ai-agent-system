#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeMinOrderPressureReport } from './runtime-min-order-pressure-report.ts';

const DEFAULT_FILE = '/tmp/investment-runtime-min-order-pressure-history.jsonl';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const marketArg = argv.find((arg) => arg.startsWith('--market='));
  const fileArg = argv.find((arg) => arg.startsWith('--file='));
  return {
    days: Math.max(1, Number(daysArg?.split('=')[1] || 14)),
    market: String(marketArg?.split('=').slice(1).join('=') || 'kis'),
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
    '📚 Runtime Min Order Pressure History',
    `market: ${payload.market}`,
    `file: ${payload.file}`,
    `snapshots: ${payload.historyCount}`,
    `current: ${payload.current.status}`,
    `previous: ${payload.previous?.status || 'none'}`,
    `count delta: ${payload.delta.count >= 0 ? '+' : ''}${payload.delta.count}`,
    `avg gap delta: ${payload.delta.avgGap >= 0 ? '+' : ''}${Math.round(payload.delta.avgGap)}`,
    '',
    `headline: ${payload.current.headline}`,
    '',
    '권장 조치:',
    ...payload.current.actionItems.map((item) => `- ${item}`),
  ].join('\n');
}

export async function buildRuntimeMinOrderPressureHistory({ market = 'kis', days = 14, file = DEFAULT_FILE, json = false } = {}) {
  const report = await buildRuntimeMinOrderPressureReport({ market, days, json: true });
  const current = {
    recordedAt: new Date().toISOString(),
    market: report.market,
    status: report.decision.status,
    headline: report.decision.headline,
    count: Number(report.count || 0),
    avgGap: Number(report.decision?.metrics?.avgGap || 0),
    maxGap: Number(report.decision?.metrics?.maxGap || 0),
    actionItems: report.decision.actionItems || [],
  };
  const history = readHistory(file);
  const previous = history[history.length - 1] || null;
  appendHistory(file, current);
  const payload = {
    ok: true,
    market: report.market,
    file,
    historyCount: history.length + 1,
    current,
    previous,
    delta: {
      count: previous ? current.count - Number(previous.count || 0) : 0,
      avgGap: previous ? current.avgGap - Number(previous.avgGap || 0) : 0,
      maxGap: previous ? current.maxGap - Number(previous.maxGap || 0) : 0,
    },
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeMinOrderPressureHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-min-order-pressure-history 오류:',
  });
}
