#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeDecisionReport } from './runtime-decision-report.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';

function parseArgs(argv = []) {
  const args = { market: 'all', limit: 5, json: false };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw.startsWith('--market=')) args.market = String(raw.split('=').slice(1).join('=') || 'all');
    else if (raw.startsWith('--limit=')) args.limit = Math.max(1, Number(raw.split('=').slice(1).join('=') || 5));
  }
  return args;
}

function countBy(rows = [], pick) {
  const counts = {};
  for (const row of rows) {
    const key = pick(row);
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  const topEntry = Object.entries(counts).sort((a, b) => Number(b[1]) - Number(a[1]))[0];
  return {
    counts,
    top: topEntry ? { key: topEntry[0], count: Number(topEntry[1]) } : null,
  };
}

function buildDecision(report) {
  const rows = report.rows || [];
  const summary = report.summary || {};
  const approvedSignals = Number(summary.approvedSignals || 0);
  const executedSymbols = Number(summary.executedSymbols || 0);
  const riskRejected = Number(summary.riskRejected || 0);
  const plannerAttached = rows.filter((row) => row.plannerMode).length;
  const debatePressed = rows.filter((row) => Number(row.debateLimit || 0) > 0 && Number(row.debateCount || 0) >= Number(row.debateLimit || 0)).length;
  const topRiskReject = countBy(rows, (row) => row.riskRejectReasonTop);
  const topPlannerMode = countBy(rows, (row) => row.plannerMode);
  const executionRatio = approvedSignals > 0 ? executedSymbols / approvedSignals : 0;

  let status = 'runtime_ok';
  let headline = '런타임 의사결정 흐름은 안정적으로 관찰됩니다.';
  const reasons = [];

  if (report.count === 0) {
    status = 'runtime_idle';
    headline = '최근 runtime decision 세션이 아직 없습니다.';
    reasons.push('bridge_status가 있는 최근 pipeline_runs가 없습니다.');
  } else {
    reasons.push(`최근 세션 ${report.count}건 관찰`);
    reasons.push(`approved ${approvedSignals}, executed ${executedSymbols}, riskRejected ${riskRejected}`);
    if (topRiskReject.top) {
      reasons.push(`최다 risk reject: ${topRiskReject.top.key} (${topRiskReject.top.count}건)`);
    }
    if (topPlannerMode.top) {
      reasons.push(`최다 planner mode: ${topPlannerMode.top.key} (${topPlannerMode.top.count}건)`);
    }
  }

  if (report.count > 0 && approvedSignals > 0 && executedSymbols === 0) {
    status = 'runtime_hold';
    headline = '승인 신호는 있지만 실행까지 이어지지 않고 있습니다.';
  } else if (riskRejected > approvedSignals && riskRejected > 0) {
    status = 'runtime_risk_heavy';
    headline = '리스크 가드가 의사결정 후반을 강하게 막고 있습니다.';
  }

  const actionItems = [];
  if (status === 'runtime_idle') {
    actionItems.push('실제 pipeline run이 더 쌓인 뒤 다시 확인합니다.');
  } else {
    if (plannerAttached < report.count) {
      actionItems.push('planner 메타가 비어 있는 runtime 세션이 있는지 점검합니다.');
    }
    if (debatePressed > 0) {
      actionItems.push('debate limit에 자주 닿는 세션이 있는지 계속 관찰합니다.');
    }
    if (approvedSignals > 0 && executedSymbols === 0) {
      actionItems.push('approved 대비 executed 비율이 0인 원인을 risk reject / execution gate 기준으로 점검합니다.');
    }
    if (topRiskReject.top) {
      actionItems.push(`현재 최상위 거절 사유 '${topRiskReject.top.key}'를 기준으로 포지션/한도 상태를 확인합니다.`);
    }
    if (actionItems.length === 0) {
      actionItems.push('현재 기준선을 유지하면서 런타임 세션 데이터를 계속 누적합니다.');
    }
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      count: report.count,
      approvedSignals,
      executedSymbols,
      executionRatio,
      riskRejected,
      plannerAttached,
      debatePressed,
      topRiskReject: topRiskReject.top,
      topPlannerMode: topPlannerMode.top,
    },
  };
}

function formatSummaryText(payload) {
  const { market, limit, decision, runtime } = payload;
  const lines = [
    '🧠 Runtime Decision Summary',
    `market: ${market}`,
    `limit: ${limit}`,
    `status: ${decision.status}`,
    `headline: ${decision.headline}`,
    payload.aiSummary ? `🔍 AI: ${payload.aiSummary}` : null,
    '',
    '근거:',
    ...decision.reasons.map((reason) => `- ${reason}`),
    '',
    '핵심 지표:',
    `- approvedSignals: ${decision.metrics.approvedSignals}`,
    `- executedSymbols: ${decision.metrics.executedSymbols}`,
    `- executionRatio: ${decision.metrics.executionRatio.toFixed(2)}`,
    `- riskRejected: ${decision.metrics.riskRejected}`,
    `- plannerAttached: ${decision.metrics.plannerAttached}/${runtime.count}`,
    `- debatePressed: ${decision.metrics.debatePressed}`,
  ];

  if (decision.metrics.topRiskReject?.key) {
    lines.push(`- topRiskReject: ${decision.metrics.topRiskReject.key} (${decision.metrics.topRiskReject.count})`);
  }
  if (decision.metrics.topPlannerMode?.key) {
    lines.push(`- topPlannerMode: ${decision.metrics.topPlannerMode.key} (${decision.metrics.topPlannerMode.count})`);
  }

  lines.push('');
  lines.push('권장 조치:');
  lines.push(...decision.actionItems.map((item) => `- ${item}`));
  return lines.filter(Boolean).join('\n');
}

function buildRuntimeDecisionFallback(payload) {
  const decision = payload?.decision || {};
  const metrics = decision.metrics || {};
  if (decision.status === 'runtime_hold') {
    return '승인 신호는 보이지만 실행까지 이어지지 않아, 리스크 가드와 실행 게이트를 먼저 점검해야 합니다.';
  }
  if (decision.status === 'runtime_risk_heavy') {
    return '리스크 가드가 의사결정 후반을 강하게 막고 있어, 최상위 거절 사유부터 정리하는 편이 좋습니다.';
  }
  if (decision.status === 'runtime_idle') {
    return '최근 runtime decision 세션이 없어, 실제 세션이 더 쌓일 때까지 관찰 유지가 적절합니다.';
  }
  return `최근 ${metrics.count || 0}건의 runtime session은 대체로 안정적이며, approved 대비 executed 비율만 계속 관찰하면 됩니다.`;
}

export async function buildRuntimeDecisionSummary({ market = 'all', limit = 5, json = false } = {}) {
  const runtime = await buildRuntimeDecisionReport({ market, limit, json: true });
  const decision = buildDecision(runtime);
  const payload = {
    ok: true,
    market,
    limit,
    runtime,
    decision,
  };
  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-decision-summary',
    requestType: 'runtime-decision-summary',
    title: '투자 런타임 의사결정 요약',
    data: {
      market,
      limit,
      decision,
      summary: runtime.summary,
      count: runtime.count,
    },
    fallback: buildRuntimeDecisionFallback(payload),
  });
  if (json) return payload;
  return formatSummaryText(payload);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await buildRuntimeDecisionSummary(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-decision-summary 오류:',
  });
}
