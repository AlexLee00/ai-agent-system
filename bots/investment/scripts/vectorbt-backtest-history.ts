#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildVectorBtBacktestReport } from './vectorbt-backtest-report.ts';

const DEFAULT_FILE = '/tmp/investment-vectorbt-backtest-history.jsonl';

function parseArgs(argv = []) {
  const args = {
    file: DEFAULT_FILE,
    symbol: null,
    days: 30,
    limit: 20,
    json: false,
  };

  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw.startsWith('--file=')) args.file = raw.split('=').slice(1).join('=') || DEFAULT_FILE;
    else if (raw.startsWith('--symbol=')) args.symbol = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--days=')) args.days = Math.max(1, Number(raw.split('=').slice(1).join('=') || 30));
    else if (raw.startsWith('--limit=')) args.limit = Math.max(1, Number(raw.split('=').slice(1).join('=') || 20));
  }

  return args;
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
  const lines = [
    '🗂️ VectorBT Backtest History',
    `저장 파일: ${payload.file}`,
    `누적 스냅샷: ${payload.historyCount}건`,
    '',
    `현재 상태: ${payload.current.status}`,
    `이전 상태: ${payload.previous?.status || '없음'}`,
    `상태 변화: ${payload.statusChanged ? `${payload.previous?.status || 'none'} -> ${payload.current.status}` : '유지'}`,
    `ok 변화: ${payload.delta.ok >= 0 ? '+' : ''}${payload.delta.ok}`,
    `issue 변화: ${payload.delta.issue >= 0 ? '+' : ''}${payload.delta.issue}`,
    '',
    `요약: ${payload.current.headline}`,
    '',
    '권장 조치:',
    ...payload.current.actionItems.map((item) => `- ${item}`),
  ];
  return lines.join('\n');
}

export async function buildVectorBtBacktestHistory(args = {}) {
  const report = await buildVectorBtBacktestReport({
    symbol: args.symbol,
    days: args.days,
    limit: args.limit,
    json: true,
  });

  const current = {
    recordedAt: new Date().toISOString(),
    status: report.decision.status,
    headline: report.decision.headline,
    ok: Number(report.decision.metrics.ok || 0),
    issue: Number(report.decision.metrics.issue || 0),
    actionItems: report.decision.actionItems || [],
  };

  const history = readHistory(args.file);
  const previous = history[history.length - 1] || null;
  appendHistory(args.file, current);

  const payload = {
    ok: true,
    file: args.file,
    historyCount: history.length + 1,
    current,
    previous,
    statusChanged: previous ? previous.status !== current.status : false,
    delta: {
      ok: previous ? current.ok - Number(previous.ok || 0) : 0,
      issue: previous ? current.issue - Number(previous.issue || 0) : 0,
    },
  };

  if (args.json) return payload;
  return renderText(payload);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const args = parseArgs(process.argv.slice(2));
      return buildVectorBtBacktestHistory(args);
    },
    onSuccess: async (result) => {
      if (typeof result === 'string') console.log(result);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '❌ vectorbt-backtest-history 오류:',
  });
}
