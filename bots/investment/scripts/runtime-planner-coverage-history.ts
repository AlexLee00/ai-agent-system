#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimePlannerCoverageReport } from './runtime-planner-coverage-report.ts';

const DEFAULT_FILE = '/tmp/investment-runtime-planner-coverage-history.jsonl';

function parseArgs(argv = process.argv.slice(2)) {
  const limitArg = argv.find((arg) => arg.startsWith('--limit='));
  const fileArg = argv.find((arg) => arg.startsWith('--file='));
  return {
    limit: Math.max(1, Number(limitArg?.split('=')[1] || 5)),
    file: fileArg?.split('=').slice(1).join('=') || DEFAULT_FILE,
    json: argv.includes('--json'),
    includeSmoke: argv.includes('--include-smoke'),
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
    '🗂️ Runtime Planner Coverage History',
    `저장 파일: ${payload.file}`,
    `누적 스냅샷: ${payload.historyCount}건`,
    '',
    `현재 상태: ${payload.current.status}`,
    `이전 상태: ${payload.previous?.status || '없음'}`,
    `상태 변화: ${payload.statusChanged ? `${payload.previous?.status || 'none'} -> ${payload.current.status}` : '유지'}`,
    `attached market 변화: ${payload.delta.attachedMarkets >= 0 ? '+' : ''}${payload.delta.attachedMarkets}`,
    `fully attached 변화: ${payload.delta.fullyAttachedMarkets >= 0 ? '+' : ''}${payload.delta.fullyAttachedMarkets}`,
    '',
    `요약: ${payload.current.headline}`,
    '',
    '권장 조치:',
    ...payload.current.actionItems.map((item) => `- ${item}`),
  ];
  return lines.join('\n');
}

export async function buildRuntimePlannerCoverageHistory({ limit = 5, file = DEFAULT_FILE, json = false, includeSmoke = false } = {}) {
  const report = await buildRuntimePlannerCoverageReport({ limit, json: true, includeSmoke });
  const current = {
    recordedAt: new Date().toISOString(),
    status: report.decision.status,
    headline: report.decision.headline,
    covered: Number(report.decision.metrics.covered || 0),
    attachedMarkets: Number(report.decision.metrics.attachedMarkets || 0),
    fullyAttachedMarkets: Number(report.decision.metrics.fullyAttachedMarkets || 0),
    missingPlannerMarkets: Number(report.decision.metrics.missingPlannerMarkets || 0),
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
      attachedMarkets: previous ? current.attachedMarkets - Number(previous.attachedMarkets || 0) : 0,
      fullyAttachedMarkets: previous ? current.fullyAttachedMarkets - Number(previous.fullyAttachedMarkets || 0) : 0,
    },
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimePlannerCoverageHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-planner-coverage-history 오류:',
  });
}
