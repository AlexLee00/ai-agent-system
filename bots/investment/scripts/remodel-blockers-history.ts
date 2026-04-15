#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRemodelBlockersReport } from './remodel-blockers-report.ts';

const DEFAULT_FILE = '/tmp/investment-remodel-blockers-history.jsonl';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const fileArg = argv.find((arg) => arg.startsWith('--file='));
  return {
    days: Math.max(7, Number(daysArg?.split('=')[1] || 14)),
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
    '🗂️ Luna Remodel Blockers History',
    `저장 파일: ${payload.file}`,
    `누적 스냅샷: ${payload.historyCount}건`,
    '',
    `현재 상태: ${payload.current.status}`,
    `이전 상태: ${payload.previous?.status || '없음'}`,
    `blocker 수: ${payload.current.blockerCount}`,
    `상태 변화: ${payload.statusChanged ? `${payload.previous?.status || 'none'} -> ${payload.current.status}` : '유지'}`,
  ].join('\n');
}

export async function buildRemodelBlockersHistory({ days = 14, file = DEFAULT_FILE, json = false } = {}) {
  const report = await buildRemodelBlockersReport({ days, json: true });
  const current = {
    recordedAt: new Date().toISOString(),
    status: report.decision.status,
    blockerCount: report.blockers.length,
    closeoutStatus: report.closeoutStatus,
    categories: report.blockers.map((blocker) => blocker.category),
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
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRemodelBlockersHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ remodel-blockers-history 오류:',
  });
}
