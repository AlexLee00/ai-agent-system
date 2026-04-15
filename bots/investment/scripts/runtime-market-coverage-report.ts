#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
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
  };
}

function countBy(rows = [], pick) {
  const counts = {};
  for (const row of rows) {
    const key = pick(row);
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => Number(b[1]) - Number(a[1]))[0];
  return {
    counts,
    top: top ? { key: top[0], count: Number(top[1]) } : null,
  };
}

function buildMarketRow(market, report) {
  const rows = report?.rows || [];
  const plannerAttached = rows.filter((row) => row.plannerMode).length;
  const topBridge = countBy(rows, (row) => row.bridgeStatus).top;
  const latest = rows[0] || null;

  return {
    market: market.key,
    label: market.label,
    count: Number(report?.count || 0),
    approvedSignals: Number(report?.summary?.approvedSignals || 0),
    executedSymbols: Number(report?.summary?.executedSymbols || 0),
    riskRejected: Number(report?.summary?.riskRejected || 0),
    plannerAttached,
    latestStartedAt: latest?.startedAt || null,
    latestTradeMode: latest?.investmentTradeMode || null,
    latestPlannerMode: latest?.plannerMode || null,
    topBridgeStatus: topBridge?.key || null,
  };
}

function buildDecision(rows = []) {
  const covered = rows.filter((row) => row.count > 0).length;
  const missing = rows.filter((row) => row.count === 0).length;
  const plannerMissing = rows.filter((row) => row.count > 0 && row.plannerAttached === 0).length;

  let status = 'coverage_ok';
  let headline = '모든 시장에 runtime decision 세션 표본이 있습니다.';
  const reasons = [
    `시장 ${rows.length}개 중 coverage ${covered} / missing ${missing}`,
  ];
  const actionItems = [];

  if (missing > 0) {
    status = 'coverage_gap';
    headline = 'runtime decision 세션이 없는 시장이 있습니다.';
    reasons.push(`세션 없음: ${rows.filter((row) => row.count === 0).map((row) => row.label).join(', ')}`);
    actionItems.push('coverage가 비어 있는 시장은 run-pipeline-node no-op 드라이런부터 누적합니다.');
  }
  if (plannerMissing > 0) {
    reasons.push(`planner 미부착 시장 ${plannerMissing}개`);
    actionItems.push('runtime 세션은 있지만 planner 메타가 없는 시장은 bridge 메타 누적을 점검합니다.');
  }
  if (actionItems.length === 0) {
    actionItems.push('현재 market coverage를 유지하면서 시계열 추세를 계속 누적합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      totalMarkets: rows.length,
      covered,
      missing,
      plannerMissing,
    },
  };
}

function renderText(payload) {
  const lines = [
    '🗺️ Runtime Market Coverage',
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '시장별:',
    ...payload.rows.map((row) =>
      `- ${row.label}(${row.market}) | count=${row.count} | approved=${row.approvedSignals} | executed=${row.executedSymbols} | riskRejected=${row.riskRejected} | planner=${row.plannerAttached}/${row.count} | bridge=${row.topBridgeStatus || 'none'}`
    ),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ];
  return lines.join('\n');
}

export async function buildRuntimeMarketCoverageReport({ limit = 5, json = false } = {}) {
  const reports = {};
  for (const market of MARKETS) {
    reports[market.key] = await buildRuntimeDecisionReport({ market: market.key, limit, json: true }).catch(() => null);
  }
  const rows = MARKETS.map((market) => buildMarketRow(market, reports[market.key]));
  const decision = buildDecision(rows);
  const payload = {
    ok: true,
    limit,
    rows,
    reports,
    decision,
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeMarketCoverageReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-market-coverage-report 오류:',
  });
}
