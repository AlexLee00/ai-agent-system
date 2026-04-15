#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeAutotuneReadinessReport } from './runtime-autotune-readiness-report.ts';

const DEFAULT_FILE = '/tmp/investment-runtime-autotune-readiness-history.jsonl';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const limitArg = argv.find((arg) => arg.startsWith('--limit='));
  const fileArg = argv.find((arg) => arg.startsWith('--file='));
  return {
    days: Math.max(7, Number(daysArg?.split('=')[1] || 14)),
    limit: Math.max(1, Number(limitArg?.split('=')[1] || 20)),
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
  const lines = [
    '🗂️ Runtime Autotune Readiness History',
    `저장 파일: ${payload.file}`,
    `누적 스냅샷: ${payload.historyCount}건`,
    '',
    `현재 상태: ${payload.current.status}`,
    `이전 상태: ${payload.previous?.status || '없음'}`,
    `상태 변화: ${payload.statusChanged ? `${payload.previous?.status || 'none'} -> ${payload.current.status}` : '유지'}`,
    `readyCandidates 변화: ${payload.delta.readyCandidates >= 0 ? '+' : ''}${payload.delta.readyCandidates}`,
    '',
    `요약: ${payload.current.headline}`,
    '',
    '권장 조치:',
    ...payload.current.actionItems.map((item) => `- ${item}`),
  ];
  return lines.join('\n');
}

export async function buildRuntimeAutotuneReadinessHistory({ days = 14, limit = 20, file = DEFAULT_FILE, json = false } = {}) {
  const report = await buildRuntimeAutotuneReadinessReport({ days, limit, json: true });
  const current = {
    recordedAt: new Date().toISOString(),
    status: report.decision.status,
    headline: report.decision.headline,
    readyCandidates: Number(report.decision.metrics.readyCandidates || 0),
    plannerReady: Boolean(report.decision.metrics.plannerReady),
    minOrderBlocked: Boolean(report.decision.metrics.minOrderBlocked),
    backtestOk: Boolean(report.decision.metrics.backtestOk),
    actionItems: report.decision.actionItems || [],
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
    statusChanged: previous ? previous.status !== current.status : false,
    delta: {
      readyCandidates: previous ? current.readyCandidates - Number(previous.readyCandidates || 0) : 0,
    },
  };

  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeAutotuneReadinessHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-autotune-readiness-history 오류:',
  });
}
