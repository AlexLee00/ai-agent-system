#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { reevaluateOpenPositions } from '../shared/position-reevaluator.ts';

function parseArgs(argv = []) {
  const args = {
    exchange: null,
    tradeMode: null,
    paper: false,
    persist: true,
    json: false,
    minutesBack: 180,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--paper') args.paper = true;
    else if (raw === '--no-persist') args.persist = false;
    else if (raw.startsWith('--exchange=')) args.exchange = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--trade-mode=')) args.tradeMode = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--minutes=')) args.minutesBack = Math.max(10, Number(raw.split('=').slice(1).join('=') || 180));
  }
  return args;
}

function topReason(rows = [], recommendation) {
  const counts = {};
  for (const row of rows.filter((item) => item.recommendation === recommendation)) {
    const key = String(row.reasonCode || 'unknown');
    counts[key] = (counts[key] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => Number(b[1]) - Number(a[1]))[0];
  return top ? { code: top[0], count: Number(top[1]) } : null;
}

function buildDecision(report) {
  const rows = report.rows || [];
  const exits = Number(report.summary?.exit || 0);
  const adjusts = Number(report.summary?.adjust || 0);
  const holds = Number(report.summary?.hold || 0);
  const count = Number(report.count || 0);
  const topExit = topReason(rows, 'EXIT');
  const topAdjust = topReason(rows, 'ADJUST');

  let status = 'reeval_ok';
  let headline = '보유 포지션 재평가 레일이 안정적으로 기록되고 있습니다.';
  const reasons = [`재평가 ${count}건 (HOLD ${holds} / ADJUST ${adjusts} / EXIT ${exits})`];

  if (topExit) reasons.push(`최다 EXIT 사유: ${topExit.code} (${topExit.count}건)`);
  if (topAdjust) reasons.push(`최다 ADJUST 사유: ${topAdjust.code} (${topAdjust.count}건)`);

  if (count === 0) {
    status = 'reeval_idle';
    headline = '현재 재평가할 오픈 포지션이 없습니다.';
  } else if (exits > 0) {
    status = 'reeval_attention';
    headline = '즉시 청산 후보(EXIT)가 관찰되었습니다.';
  } else if (adjusts > holds) {
    status = 'reeval_adjust_heavy';
    headline = '부분익절/TP 조정 후보가 HOLD보다 많습니다.';
  }

  const actionItems = [];
  if (status === 'reeval_idle') {
    actionItems.push('새 오픈 포지션이 생기면 재평가 누적을 계속 확인합니다.');
  } else {
    if (exits > 0) actionItems.push('EXIT 후보 종목의 손절/추세전환 조건을 우선 점검합니다.');
    if (adjusts > 0) actionItems.push('ADJUST 후보 종목의 부분익절/TP 조정 규칙을 비교합니다.');
    if (rows.some((row) => Number(row.analysisSnapshot?.total || 0) === 0)) {
      actionItems.push('분석 데이터가 비어 있는 포지션은 시장 데이터/분석 주기와 함께 재확인합니다.');
    }
    if (actionItems.length === 0) {
      actionItems.push('현재 기준선을 유지하며 재평가 데이터를 계속 누적합니다.');
    }
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      count,
      holds,
      adjusts,
      exits,
      topExit,
      topAdjust,
    },
  };
}

function renderText(payload) {
  const { args, report, decision } = payload;
  const lines = [
    '🔁 Position Reevaluation Summary',
    `exchange: ${args.exchange || 'all'}`,
    `tradeMode: ${args.tradeMode || 'all'}`,
    `paper: ${args.paper}`,
    `status: ${decision.status}`,
    `headline: ${decision.headline}`,
    '',
    '근거:',
    ...decision.reasons.map((reason) => `- ${reason}`),
    '',
    '핵심 지표:',
    `- positions: ${report.count}`,
    `- persisted: ${report.persisted}`,
    `- HOLD: ${decision.metrics.holds}`,
    `- ADJUST: ${decision.metrics.adjusts}`,
    `- EXIT: ${decision.metrics.exits}`,
  ];

  if (decision.metrics.topExit?.code) {
    lines.push(`- topExit: ${decision.metrics.topExit.code} (${decision.metrics.topExit.count})`);
  }
  if (decision.metrics.topAdjust?.code) {
    lines.push(`- topAdjust: ${decision.metrics.topAdjust.code} (${decision.metrics.topAdjust.count})`);
  }

  lines.push('');
  lines.push('권장 조치:');
  lines.push(...decision.actionItems.map((item) => `- ${item}`));
  return lines.join('\n');
}

export async function buildPositionReevaluationSummary(args = {}) {
  const report = await reevaluateOpenPositions(args);
  const decision = buildDecision(report);
  const payload = { ok: true, args, report, decision };
  if (args.json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await buildPositionReevaluationSummary(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ position-reevaluation-summary 오류:',
  });
}
