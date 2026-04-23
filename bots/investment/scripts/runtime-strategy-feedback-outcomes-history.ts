#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import { buildStrategyFeedbackOutcomes } from './runtime-strategy-feedback-outcomes.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const DEFAULT_FILE = '/tmp/investment-runtime-strategy-feedback-outcomes-history.jsonl';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const fileArg = argv.find((arg) => arg.startsWith('--file='));
  return {
    days: Math.max(1, Number(daysArg?.split('=')[1] || 90)),
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

function summarizeWeakest(weak = null) {
  if (!weak) return null;
  return {
    familyBias: weak.familyBias || null,
    family: weak.family || null,
    executionKind: weak.executionKind || null,
    closed: Number(weak.closed || 0),
    winRate: weak.winRate == null ? null : Number(weak.winRate),
    avgPnlPercent: weak.avgPnlPercent == null ? null : Number(weak.avgPnlPercent),
    pnlNet: Number(weak.pnlNet || 0),
  };
}

function buildSnapshot(report, days) {
  const decision = report?.decision || {};
  const metrics = decision.metrics || {};
  return {
    recordedAt: new Date().toISOString(),
    days,
    status: decision.status || 'unknown',
    headline: decision.headline || '',
    bucketCount: Number(report?.count || 0),
    total: Number(metrics.total || 0),
    closed: Number(metrics.closed || 0),
    pnlNet: Number(metrics.pnlNet || 0),
    weakest: summarizeWeakest(metrics.weak),
    strongest: summarizeWeakest(metrics.strong),
  };
}

function buildDelta(current, previous) {
  if (!previous) {
    return {
      total: 0,
      closed: 0,
      pnlNet: 0,
      bucketCount: 0,
      weakestAvgPnlPercent: 0,
    };
  }
  return {
    total: current.total - Number(previous.total || 0),
    closed: current.closed - Number(previous.closed || 0),
    pnlNet: current.pnlNet - Number(previous.pnlNet || 0),
    bucketCount: current.bucketCount - Number(previous.bucketCount || 0),
    weakestAvgPnlPercent: current.weakest?.avgPnlPercent != null && previous.weakest?.avgPnlPercent != null
      ? current.weakest.avgPnlPercent - Number(previous.weakest.avgPnlPercent)
      : 0,
  };
}

function renderText(payload) {
  const weakest = payload.current.weakest;
  return [
    '📚 Strategy Feedback Outcomes History',
    `file: ${payload.file}`,
    `snapshots: ${payload.historyCount}`,
    `current: ${payload.current.status}`,
    `previous: ${payload.previous?.status || 'none'}`,
    `tagged delta: ${payload.delta.total >= 0 ? '+' : ''}${payload.delta.total}`,
    `closed delta: ${payload.delta.closed >= 0 ? '+' : ''}${payload.delta.closed}`,
    `pnl delta: ${payload.delta.pnlNet >= 0 ? '+' : ''}${payload.delta.pnlNet.toFixed(4)}`,
    weakest ? `weakest: ${weakest.familyBias || 'n/a'}/${weakest.family || 'n/a'}/${weakest.executionKind || 'n/a'} avg ${weakest.avgPnlPercent ?? 'n/a'}%` : 'weakest: none',
    '',
    `headline: ${payload.current.headline}`,
  ].join('\n');
}

export async function buildStrategyFeedbackOutcomesHistory({ days = 90, file = DEFAULT_FILE, json = false, write = true } = {}) {
  const report = await buildStrategyFeedbackOutcomes({ days, json: true });
  const current = buildSnapshot(report, days);
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
    delta: buildDelta(current, previous),
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildStrategyFeedbackOutcomesHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-strategy-feedback-outcomes-history 오류:',
  });
}
