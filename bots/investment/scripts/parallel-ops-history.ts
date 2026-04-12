#!/usr/bin/env node
// @ts-nocheck

import { readFile, writeFile } from 'fs/promises';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildParallelOpsReport } from './parallel-ops-report.ts';

const DEFAULT_HISTORY_FILE = '/tmp/investment-parallel-ops-history.jsonl';

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
  const currentWarn = Number(current?.health?.serviceHealth?.warnCount || 0);
  const previousWarn = Number(previous?.health?.serviceHealth?.warnCount || 0);

  return {
    currentStatus: current?.decision?.status || 'unknown',
    previousStatus: previous?.decision?.status || null,
    statusChanged: previous ? current?.decision?.status !== previous?.decision?.status : false,
    currentWarnCount: currentWarn,
    previousWarnCount: previous ? previousWarn : null,
    warnDelta: previous ? currentWarn - previousWarn : null,
  };
}

function formatHistoryText({ filePath, current, comparison, historyCount }) {
  const lines = [
    '🗂️ 병렬 운영 히스토리 리포트',
    `저장 파일: ${filePath}`,
    `누적 스냅샷: ${historyCount}건`,
    '',
    `현재 상태: ${comparison.currentStatus}`,
  ];

  if (comparison.previousStatus) {
    lines.push(`이전 상태: ${comparison.previousStatus}`);
    lines.push(`상태 변화: ${comparison.statusChanged ? '변경됨' : '유지'}`);
  }

  lines.push(`현재 warn 수: ${comparison.currentWarnCount}`);
  if (comparison.warnDelta != null) {
    lines.push(`warn 변화량: ${comparison.warnDelta >= 0 ? '+' : ''}${comparison.warnDelta}`);
  }

  lines.push('');
  lines.push(`요약: ${current.decision.headline}`);
  if (current.actionItems?.length) {
    lines.push('');
    lines.push('권장 조치:');
    lines.push(...current.actionItems.map((item) => `- ${item}`));
  }

  return lines.join('\n');
}

export async function buildParallelOpsHistory({
  filePath = DEFAULT_HISTORY_FILE,
  append = true,
  json = false,
} = {}) {
  const current = await buildParallelOpsReport({ json: true });
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
  const result = await buildParallelOpsHistory({
    filePath,
    append: !noAppend,
    json,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ parallel-ops-history 오류:',
  });
}
