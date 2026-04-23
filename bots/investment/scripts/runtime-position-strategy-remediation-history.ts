#!/usr/bin/env node
// @ts-nocheck

import fs from 'fs';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runPositionStrategyRemediation } from './runtime-position-strategy-remediation.ts';

const DEFAULT_FILE = '/tmp/investment-runtime-position-strategy-remediation-history.jsonl';

function parseArgs(argv = process.argv.slice(2)) {
  const fileArg = argv.find((arg) => arg.startsWith('--file='));
  return {
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
    '🗂️ Position Strategy Remediation History',
    `저장 파일: ${payload.file}`,
    `누적 스냅샷: ${payload.historyCount}건`,
    '',
    `현재 상태: ${payload.current.status}`,
    `이전 상태: ${payload.previous?.status || '없음'}`,
    `상태 변화: ${payload.statusChanged ? `${payload.previous?.status || 'none'} -> ${payload.current.status}` : '유지'}`,
    `focus 변화: ${payload.previous?.recommendedExchange || 'none'} -> ${payload.current.recommendedExchange || 'none'}`,
    `duplicate 변화: ${payload.delta.duplicateManaged >= 0 ? '+' : ''}${payload.delta.duplicateManaged}`,
    `orphan 변화: ${payload.delta.orphanProfiles >= 0 ? '+' : ''}${payload.delta.orphanProfiles}`,
    `unmatched 변화: ${payload.delta.unmatchedManaged >= 0 ? '+' : ''}${payload.delta.unmatchedManaged}`,
    '',
    `요약: ${payload.current.headline}`,
    '',
    '권장 조치:',
    ...payload.current.actionItems.map((item) => `- ${item}`),
  ].join('\n');
}

export async function buildPositionStrategyRemediationHistory({ file = DEFAULT_FILE, json = false } = {}) {
  const report = await runPositionStrategyRemediation({ json: true });
  const plan = report.remediationPlan || {};
  const current = {
    recordedAt: new Date().toISOString(),
    status: report.decision?.status || 'unknown',
    headline: report.decision?.headline || 'n/a',
    recommendedExchange: plan.recommendedExchange || null,
    duplicateManaged: Number(plan.duplicateManagedScopes || 0),
    orphanProfiles: Number(plan.orphanProfiles || 0),
    unmatchedManaged: Number(plan.unmatchedManaged || 0),
    actionItems: report.decision?.actionItems || [],
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
      duplicateManaged: previous ? current.duplicateManaged - Number(previous.duplicateManaged || 0) : 0,
      orphanProfiles: previous ? current.orphanProfiles - Number(previous.orphanProfiles || 0) : 0,
      unmatchedManaged: previous ? current.unmatchedManaged - Number(previous.unmatchedManaged || 0) : 0,
    },
  };

  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildPositionStrategyRemediationHistory(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-position-strategy-remediation-history 오류:',
  });
}
