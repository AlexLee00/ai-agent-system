#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';
import { buildRuntimeDecisionReport } from './runtime-decision-report.ts';

const MARKETS = [
  { key: 'binance', label: 'crypto' },
  { key: 'kis', label: 'domestic' },
  { key: 'kis_overseas', label: 'overseas' },
];

function parseArgs(argv = process.argv.slice(2)) {
  const limitArg = argv.find((arg) => arg.startsWith('--limit='));
  return {
    limit: Math.max(1, Number(limitArg?.split('=')[1] || 5)),
    json: argv.includes('--json'),
    includeSmoke: argv.includes('--include-smoke'),
  };
}

function buildMarketRow(market, report) {
  const rows = report?.rows || [];
  const attached = rows.filter((row) => row.plannerMode).length;
  const latest = rows[0] || null;
  return {
    market: market.key,
    label: market.label,
    count: Number(report?.count || 0),
    attached,
    missing: Math.max(0, Number(report?.count || 0) - attached),
    ratio: Number(report?.count || 0) > 0 ? Number((attached / Number(report.count || 0)).toFixed(4)) : 0,
    latestStartedAt: latest?.startedAt || null,
    latestTradeMode: latest?.investmentTradeMode || null,
    latestPlannerMode: latest?.plannerMode || null,
    latestPlannerTimeMode: latest?.plannerTimeMode || null,
    latestBridgeStatus: latest?.bridgeStatus || null,
  };
}

function buildDecision(rows = []) {
  const covered = rows.filter((row) => row.count > 0);
  const attachedMarkets = covered.filter((row) => row.attached > 0).length;
  const fullyAttachedMarkets = covered.filter((row) => row.count > 0 && row.attached === row.count).length;
  const missingPlannerMarkets = covered.filter((row) => row.attached === 0).length;

  let status = 'planner_coverage_ready';
  let headline = 'planner 메타가 실세션에 안정적으로 붙고 있습니다.';
  const reasons = [
    `covered market ${covered.length}개`,
    `attached market ${attachedMarkets}개 / fully attached ${fullyAttachedMarkets}개`,
  ];
  const actionItems = [];

  if (covered.length === 0) {
    status = 'planner_coverage_waiting';
    headline = '아직 관찰 가능한 runtime 실세션이 없습니다.';
    actionItems.push('시장 세션이 한 번 더 누적된 뒤 planner 부착률을 다시 확인합니다.');
  } else if (missingPlannerMarkets === covered.length) {
    status = 'planner_coverage_gap';
    headline = 'covered market 전부에서 planner 메타가 아직 실세션에 붙지 않았습니다.';
    reasons.push(`planner 미부착 market: ${covered.map((row) => row.label).join(', ')}`);
    actionItems.push('planner_payload가 실제 market session meta에 계속 심어지는지 다음 실세션 누적을 관찰합니다.');
  } else if (missingPlannerMarkets > 0) {
    status = 'planner_coverage_partial';
    headline = '일부 market에서는 planner 메타가 붙기 시작했지만 아직 전시장 적용은 아닙니다.';
    reasons.push(`planner 미부착 market: ${covered.filter((row) => row.attached === 0).map((row) => row.label).join(', ')}`);
    actionItems.push('planner attached market과 미부착 market의 최신 bridge/meta 차이를 비교합니다.');
  }

  if (actionItems.length === 0) {
    actionItems.push('현재 planner attached ratio를 유지하면서 실세션 누적 추세를 계속 기록합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      totalMarkets: rows.length,
      covered: covered.length,
      attachedMarkets,
      fullyAttachedMarkets,
      missingPlannerMarkets,
    },
  };
}

function renderText(payload) {
  const lines = [
    '🧭 Runtime Planner Coverage',
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    payload.aiSummary ? `🔍 AI: ${payload.aiSummary}` : null,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '시장별:',
    ...payload.rows.map((row) =>
      `- ${row.label}(${row.market}) | attached=${row.attached}/${row.count} | ratio=${(row.ratio * 100).toFixed(0)}% | latestPlanner=${row.latestPlannerMode || 'none'} | tradeMode=${row.latestTradeMode || 'none'} | bridge=${row.latestBridgeStatus || 'none'}`
    ),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ];
  return lines.filter(Boolean).join('\n');
}

function buildRuntimePlannerCoverageFallback(payload = {}) {
  const decision = payload.decision || {};
  const metrics = decision.metrics || {};
  if (decision.status === 'planner_coverage_gap') {
    return `planner 메타가 covered market ${metrics.covered || 0}개에 아직 붙지 않아 bridge 메타 누적 상태를 먼저 확인하는 편이 좋습니다.`;
  }
  if (decision.status === 'planner_coverage_partial') {
    return `planner 메타는 일부 market에서만 붙고 있어 attached ${metrics.attachedMarkets || 0}/${metrics.covered || 0} 시장 차이를 비교하는 편이 좋습니다.`;
  }
  if (decision.status === 'planner_coverage_waiting') {
    return '아직 실세션 표본이 적어 planner coverage는 시장 세션이 더 쌓인 뒤 다시 보는 편이 좋습니다.';
  }
  return `planner 메타는 covered market ${metrics.covered || 0}개 기준으로 비교적 안정적으로 붙고 있어 현재 추세를 계속 누적하면 됩니다.`;
}

export async function buildRuntimePlannerCoverageReport({ limit = 5, json = false, includeSmoke = false } = {}) {
  const reports = {};
  for (const market of MARKETS) {
    reports[market.key] = await buildRuntimeDecisionReport({
      market: market.key,
      limit,
      json: true,
      includeSmoke,
    }).catch(() => null);
  }
  const rows = MARKETS.map((market) => buildMarketRow(market, reports[market.key]));
  const decision = buildDecision(rows);
  const payload = {
    ok: true,
    limit,
    includeSmoke,
    rows,
    reports,
    decision,
  };
  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-planner-coverage-report',
    requestType: 'runtime-planner-coverage-report',
    title: '투자 runtime planner coverage 리포트 요약',
    data: {
      limit,
      includeSmoke,
      rows,
      decision,
    },
    fallback: buildRuntimePlannerCoverageFallback(payload),
  });
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimePlannerCoverageReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-planner-coverage-report 오류:',
  });
}
