#!/usr/bin/env node
// @ts-nocheck

import { execFile } from 'child_process';
import { promisify } from 'util';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildVectorBtBacktestReport } from './vectorbt-backtest-report.ts';

const execFileAsync = promisify(execFile);

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const limitArg = argv.find((arg) => arg.startsWith('--limit='));
  return {
    days: Math.max(7, Number(daysArg?.split('=')[1] || 14)),
    limit: Math.max(1, Number(limitArg?.split('=')[1] || 20)),
    json: argv.includes('--json'),
  };
}

async function loadRuntimeSuggestionReport(days) {
  const { stdout } = await execFileAsync('node', [
    new URL('./runtime-config-suggestions.ts', import.meta.url).pathname,
    `--days=${days}`,
    '--json',
  ], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 8,
  });
  const text = String(stdout || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('runtime-config-suggestions JSON 본문을 찾지 못했습니다.');
  }
  return JSON.parse(text.slice(start, end + 1));
}

function classifyCandidate(item) {
  const governance = item.governance || {};
  const action = String(item.action || 'observe');
  const confidence = String(item.confidence || 'low');
  const autoCandidate =
    governance.tier === 'allow' &&
    ['adjust', 'promote_candidate'].includes(action) &&
    confidence !== 'low';
  return {
    ...item,
    autoCandidate,
  };
}

function buildDecision(candidates = [], backtest = null) {
  const autoCandidates = candidates.filter((item) => item.autoCandidate);
  const observeOnly = candidates.filter((item) => !item.autoCandidate);

  let status = 'allow_idle';
  let headline = '즉시 비교할 allow 등급 자동 적용 후보가 없습니다.';
  const reasons = [];
  const actionItems = [];

  if (candidates.length > 0) {
    status = autoCandidates.length > 0 ? 'allow_candidates_ready' : 'allow_observe_only';
    headline = autoCandidates.length > 0
      ? 'allow 등급 자동 적용 후보가 관찰되었습니다.'
      : 'allow 등급 제안은 있으나 아직 관찰 우선입니다.';
    reasons.push(`allow 제안 ${candidates.length}건 (auto ${autoCandidates.length} / observe ${observeOnly.length})`);
  }

  if (backtest?.decision) {
    reasons.push(`VectorBT: ${backtest.decision.status} / ${backtest.decision.headline}`);
  }

  if (autoCandidates.length > 0) {
    actionItems.push('autoCandidate=true 제안만 비교 실험 후보로 별도 누적합니다.');
  }
  if (backtest?.decision?.metrics?.bestSharpe) {
    actionItems.push('최고 샤프 조합과 allow 후보의 방향이 맞는지 함께 비교합니다.');
  }
  if (actionItems.length === 0) {
    actionItems.push('allow 등급 제안을 계속 누적하며 confidence가 높아지는지 관찰합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      total: candidates.length,
      auto: autoCandidates.length,
      observe: observeOnly.length,
    },
  };
}

function renderText(payload) {
  const lines = [
    '🟢 Runtime Allow Candidates',
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '후보:',
    ...payload.candidates.slice(0, 10).map((item) =>
      `- ${item.key} | action=${item.action} | confidence=${item.confidence} | auto=${item.autoCandidate} | suggested=${item.suggested}`
    ),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ];
  return lines.join('\n');
}

export async function buildRuntimeAllowCandidatesReport({ days = 14, limit = 20, json = false } = {}) {
  const suggestionReport = await loadRuntimeSuggestionReport(days);
  const backtest = await buildVectorBtBacktestReport({ days: 30, limit: 20, json: true }).catch(() => null);
  const candidates = (suggestionReport?.suggestions || [])
    .filter((item) => item?.governance?.tier === 'allow')
    .map(classifyCandidate)
    .slice(0, limit);
  const decision = buildDecision(candidates, backtest);
  const payload = {
    ok: true,
    days,
    limit,
    candidates,
    backtest,
    decision,
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeAllowCandidatesReport(args);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(result);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-allow-candidates-report 오류:',
  });
}
