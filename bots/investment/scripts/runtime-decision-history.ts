#!/usr/bin/env node
// @ts-nocheck

import { readFile, writeFile } from 'fs/promises';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeDecisionSummary } from './runtime-decision-summary.ts';

const DEFAULT_HISTORY_FILE = '/tmp/investment-runtime-decision-history.jsonl';

function parseArg(name, fallback = null) {
  return process.argv.slice(2).find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] || fallback;
}

async function loadHistory(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function appendHistory(filePath, payload) {
  const rows = await loadHistory(filePath);
  rows.push(payload);
  const content = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(filePath, content, 'utf8');
  return rows;
}

function buildComparison(current, previous = null) {
  const currentMetrics = current?.decision?.metrics || {};
  const previousMetrics = previous?.decision?.metrics || {};
  return {
    currentStatus: current?.decision?.status || 'unknown',
    previousStatus: previous ? previous?.decision?.status || 'unknown' : null,
    statusChanged: previous ? current?.decision?.status !== previous?.decision?.status : false,
    approvedDelta: previous ? Number(currentMetrics.approvedSignals || 0) - Number(previousMetrics.approvedSignals || 0) : null,
    executedDelta: previous ? Number(currentMetrics.executedSymbols || 0) - Number(previousMetrics.executedSymbols || 0) : null,
    riskRejectedDelta: previous ? Number(currentMetrics.riskRejected || 0) - Number(previousMetrics.riskRejected || 0) : null,
  };
}

function formatHistoryText(payload) {
  const { filePath, historyCount, current, comparison } = payload;
  const lines = [
    '🗂️ Runtime Decision History',
    `저장 파일: ${filePath}`,
    `누적 스냅샷: ${historyCount}건`,
    '',
    `현재 상태: ${comparison.currentStatus}`,
  ];

  if (comparison.previousStatus) {
    lines.push(`이전 상태: ${comparison.previousStatus}`);
    lines.push(`상태 변화: ${comparison.statusChanged ? '변경됨' : '유지'}`);
  }

  lines.push(`approved 변화: ${comparison.approvedDelta == null ? 'n/a' : `${comparison.approvedDelta >= 0 ? '+' : ''}${comparison.approvedDelta}`}`);
  lines.push(`executed 변화: ${comparison.executedDelta == null ? 'n/a' : `${comparison.executedDelta >= 0 ? '+' : ''}${comparison.executedDelta}`}`);
  lines.push(`riskRejected 변화: ${comparison.riskRejectedDelta == null ? 'n/a' : `${comparison.riskRejectedDelta >= 0 ? '+' : ''}${comparison.riskRejectedDelta}`}`);
  lines.push('');
  lines.push(`요약: ${current.decision.headline}`);
  lines.push('');
  lines.push('권장 조치:');
  lines.push(...(current.decision.actionItems || []).map((item) => `- ${item}`));
  return lines.join('\n');
}

export async function buildRuntimeDecisionHistory({
  filePath = DEFAULT_HISTORY_FILE,
  market = 'all',
  limit = 5,
  append = true,
  json = false,
} = {}) {
  const current = await buildRuntimeDecisionSummary({ market, limit, json: true });
  const existing = await loadHistory(filePath);
  const previous = existing.length > 0 ? existing[existing.length - 1] : null;
  const history = append ? await appendHistory(filePath, current) : existing;
  const comparison = buildComparison(current, previous);
  const payload = {
    filePath,
    historyCount: history.length,
    current,
    previous,
    comparison,
  };
  if (json) return payload;
  return formatHistoryText(payload);
}

async function main() {
  const json = process.argv.includes('--json');
  const noAppend = process.argv.includes('--no-append');
  const filePath = parseArg('file', DEFAULT_HISTORY_FILE);
  const market = parseArg('market', 'all');
  const limit = Math.max(1, Number(parseArg('limit', 5) || 5));
  const result = await buildRuntimeDecisionHistory({
    filePath,
    market,
    limit,
    append: !noAppend,
    json,
  });
  if (json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-decision-history 오류:',
  });
}
