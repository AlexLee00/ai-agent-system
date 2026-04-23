#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeExecutionRiskGuardReport } from './runtime-execution-risk-guard-report.ts';

const DEFAULT_FILE = '/tmp/investment-runtime-execution-risk-guard-history.jsonl';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const fileArg = argv.find((arg) => arg.startsWith('--file='));
  return {
    days: Math.max(1, Number(daysArg?.split('=')[1] || 14)),
    file: fileArg?.split('=').slice(1).join('=') || DEFAULT_FILE,
    json: argv.includes('--json'),
    write: !argv.includes('--no-write'),
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

function buildSnapshot(report) {
  return {
    recordedAt: new Date().toISOString(),
    days: Number(report.days || 14),
    status: report.decision?.status || 'unknown',
    headline: report.decision?.headline || '',
    total: Number(report.summary?.total || 0),
    staleCount: Number(report.summary?.staleCount || 0),
    bypassCount: Number(report.summary?.bypassCount || 0),
    topCode: report.summary?.byCode?.[0] || null,
    topExchange: report.summary?.byExchange?.[0] || null,
    actionItems: report.decision?.actionItems || [],
  };
}

export function buildRuntimeExecutionRiskGuardHistoryDelta(current, previous) {
  if (!previous) {
    return { total: 0, staleCount: 0, bypassCount: 0 };
  }
  return {
    total: current.total - Number(previous.total || 0),
    staleCount: current.staleCount - Number(previous.staleCount || 0),
    bypassCount: current.bypassCount - Number(previous.bypassCount || 0),
  };
}

function renderText(payload) {
  return [
    '📚 Runtime Execution Risk Guard History',
    `file: ${payload.file}`,
    `snapshots: ${payload.historyCount}`,
    `current: ${payload.current.status}`,
    `previous: ${payload.previous?.status || 'none'}`,
    `total delta: ${payload.delta.total >= 0 ? '+' : ''}${payload.delta.total}`,
    `stale delta: ${payload.delta.staleCount >= 0 ? '+' : ''}${payload.delta.staleCount}`,
    `bypass delta: ${payload.delta.bypassCount >= 0 ? '+' : ''}${payload.delta.bypassCount}`,
    '',
    `headline: ${payload.current.headline}`,
    '',
    '권장 조치:',
    ...payload.current.actionItems.map((item) => `- ${item}`),
  ].join('\n');
}

export async function buildRuntimeExecutionRiskGuardHistory({ days = 14, file = DEFAULT_FILE, json = false, write = true } = {}) {
  const report = await buildRuntimeExecutionRiskGuardReport({ days, json: true });
  const current = buildSnapshot(report);
  const history = readHistory(file);
  const previous = history[history.length - 1] || null;
  if (write) appendHistory(file, current);
  const payload = {
    ok: true,
    file,
    write,
    historyCount: history.length + (write ? 1 : 0),
    current,
    previous,
    delta: buildRuntimeExecutionRiskGuardHistoryDelta(current, previous),
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeExecutionRiskGuardHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-execution-risk-guard-history 오류:',
  });
}
