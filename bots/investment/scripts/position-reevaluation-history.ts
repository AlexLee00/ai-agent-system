#!/usr/bin/env node
// @ts-nocheck

import { readFile, writeFile } from 'fs/promises';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildPositionReevaluationSummary } from './position-reevaluation-summary.ts';

const DEFAULT_HISTORY_FILE = '/tmp/investment-position-reevaluation-history.jsonl';

function parseArg(name, fallback = null) {
  return process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] || fallback;
}

async function loadHistory(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function appendHistory(filePath, payload) {
  const rows = await loadHistory(filePath);
  rows.push(payload);
  await writeFile(filePath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
  return rows;
}

function buildComparison(current, previous = null) {
  const currentAffected = Number(current?.decision?.metrics?.familyFeedback?.affectedCount || 0);
  const previousAffected = previous ? Number(previous?.decision?.metrics?.familyFeedback?.affectedCount || 0) : null;
  return {
    currentStatus: current?.decision?.status || 'unknown',
    previousStatus: previous ? previous?.decision?.status || 'unknown' : null,
    statusChanged: previous ? current?.decision?.status !== previous?.decision?.status : false,
    exitDelta: previous ? Number(current?.decision?.metrics?.exits || 0) - Number(previous?.decision?.metrics?.exits || 0) : null,
    adjustDelta: previous ? Number(current?.decision?.metrics?.adjusts || 0) - Number(previous?.decision?.metrics?.adjusts || 0) : null,
    holdDelta: previous ? Number(current?.decision?.metrics?.holds || 0) - Number(previous?.decision?.metrics?.holds || 0) : null,
    familyFeedbackAffected: currentAffected,
    familyFeedbackAffectedDelta: previous ? currentAffected - previousAffected : null,
    familyFeedbackBias: current?.decision?.metrics?.familyFeedback?.distribution || {},
  };
}

function renderText(payload) {
  const { filePath, historyCount, current, comparison } = payload;
  const lines = [
    '🗂️ Position Reevaluation History',
    `저장 파일: ${filePath}`,
    `누적 스냅샷: ${historyCount}건`,
    '',
    `현재 상태: ${comparison.currentStatus}`,
  ];

  if (comparison.previousStatus) {
    lines.push(`이전 상태: ${comparison.previousStatus}`);
    lines.push(`상태 변화: ${comparison.statusChanged ? '변경됨' : '유지'}`);
  }

  lines.push(`EXIT 변화: ${comparison.exitDelta == null ? 'n/a' : `${comparison.exitDelta >= 0 ? '+' : ''}${comparison.exitDelta}`}`);
  lines.push(`ADJUST 변화: ${comparison.adjustDelta == null ? 'n/a' : `${comparison.adjustDelta >= 0 ? '+' : ''}${comparison.adjustDelta}`}`);
  lines.push(`HOLD 변화: ${comparison.holdDelta == null ? 'n/a' : `${comparison.holdDelta >= 0 ? '+' : ''}${comparison.holdDelta}`}`);
  lines.push(`패밀리 피드백 영향: ${comparison.familyFeedbackAffected}건${comparison.familyFeedbackAffectedDelta == null ? '' : ` (${comparison.familyFeedbackAffectedDelta >= 0 ? '+' : ''}${comparison.familyFeedbackAffectedDelta})`}`);
  lines.push(`패밀리 피드백 분포: ${Object.entries(comparison.familyFeedbackBias || {}).map(([key, value]) => `${key}:${value}`).join(', ') || 'none'}`);
  lines.push('');
  lines.push(`요약: ${current.decision.headline}`);
  lines.push('');
  lines.push('권장 조치:');
  lines.push(...(current.decision.actionItems || []).map((item) => `- ${item}`));
  return lines.join('\n');
}

export async function buildPositionReevaluationHistory({
  filePath = DEFAULT_HISTORY_FILE,
  exchange = null,
  tradeMode = null,
  paper = false,
  persist = true,
  append = true,
  json = false,
  minutesBack = 180,
} = {}) {
  const current = await buildPositionReevaluationSummary({
    exchange,
    tradeMode,
    paper,
    persist,
    json: true,
    minutesBack,
  });
  const existing = await loadHistory(filePath);
  const previous = existing.length > 0 ? existing[existing.length - 1] : null;
  const history = append ? await appendHistory(filePath, current) : existing;
  const comparison = buildComparison(current, previous);
  const payload = { filePath, historyCount: history.length, current, previous, comparison };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const json = process.argv.includes('--json');
  const noAppend = process.argv.includes('--no-append');
  const paper = process.argv.includes('--paper');
  const filePath = parseArg('file', DEFAULT_HISTORY_FILE);
  const exchange = parseArg('exchange', null);
  const tradeMode = parseArg('trade-mode', null);
  const minutesBack = Math.max(10, Number(parseArg('minutes', 180) || 180));
  const result = await buildPositionReevaluationHistory({
    filePath,
    exchange,
    tradeMode,
    paper,
    append: !noAppend,
    json,
    minutesBack,
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ position-reevaluation-history 오류:',
  });
}
