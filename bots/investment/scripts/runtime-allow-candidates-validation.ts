#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeAllowCandidatesReport } from './runtime-allow-candidates-report.ts';
import { buildRuntimeDecisionSummary } from './runtime-decision-summary.ts';
import { buildRuntimeMinOrderPressureReport } from './runtime-min-order-pressure-report.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const limitArg = argv.find((arg) => arg.startsWith('--limit='));
  return {
    days: Math.max(7, Number(daysArg?.split('=')[1] || 14)),
    limit: Math.max(1, Number(limitArg?.split('=')[1] || 20)),
    json: argv.includes('--json'),
  };
}

function inferMarketFromKey(key = '') {
  if (key.includes('kis_overseas') || key.includes('overseas')) return 'overseas';
  if (key.includes('Domestic') || key.includes('domestic') || key.includes('.kis')) return 'domestic';
  return 'crypto';
}

function inferReadiness(candidate, runtimeSummary, pressureReport = null) {
  const runtime = runtimeSummary?.decision || {};
  const metrics = runtime.metrics || {};
  const topRisk = String(metrics.topRiskReject?.key || '');
  const minOrderPressure = String(pressureReport?.decision?.status || '');

  let readiness = 'observe';
  let reason = '추가 관찰이 필요합니다.';

  if (!candidate.autoCandidate) {
    readiness = 'observe';
    reason = 'autoCandidate 조건을 아직 충족하지 않습니다.';
  } else if (runtime.status === 'runtime_idle') {
    readiness = 'observe';
    reason = '해당 시장 runtime 세션 표본이 아직 부족합니다.';
  } else if (metrics.executedSymbols > 0 && metrics.riskRejected === 0) {
    readiness = 'ready';
    reason = '실행이 이미 나오고 있고 리스크 거절이 낮아 비교 실험 후보로 적합합니다.';
  } else if (topRisk.includes('최대 포지션')) {
    readiness = 'blocked';
    reason = '현재는 최대 포지션 제한이 우세해 파라미터 비교보다 포지션 정리가 우선입니다.';
  } else if (minOrderPressure === 'min_order_runtime_pressure' || minOrderPressure === 'min_order_pressure') {
    readiness = 'blocked';
    reason = '현재는 최소 주문 병목이 실런타임 기준으로 확인돼 파라미터 비교보다 주문 단위/예산 병목 해소가 우선입니다.';
  } else if (topRisk.includes('최소 주문 미달')) {
    readiness = 'blocked';
    reason = '현재는 최소 주문금액 가드가 우세해 파라미터 비교보다 주문 단위/예산 병목 해소가 우선입니다.';
  } else if (metrics.riskRejected > metrics.executedSymbols) {
    readiness = 'observe';
    reason = '리스크 거절 비중이 높아 파라미터 비교 전 가드 병목을 더 봐야 합니다.';
  } else {
    readiness = 'ready';
    reason = 'autoCandidate이며 현재 런타임 병목이 치명적이지 않아 비교 실험 후보로 볼 수 있습니다.';
  }

  return { readiness, reason };
}

function buildDecision(rows = []) {
  const ready = rows.filter((row) => row.readiness === 'ready').length;
  const observe = rows.filter((row) => row.readiness === 'observe').length;
  const blocked = rows.filter((row) => row.readiness === 'blocked').length;

  let status = 'validation_idle';
  let headline = '검증할 autoCandidate가 아직 없습니다.';
  const reasons = [];
  const actionItems = [];

  if (rows.length > 0) {
    status = ready > 0 ? 'validation_ready' : blocked > 0 ? 'validation_blocked' : 'validation_observe';
    headline =
      ready > 0
        ? '즉시 비교 가능한 autoCandidate가 있습니다.'
        : blocked > 0
          ? 'autoCandidate가 있지만 현재 런타임 병목 때문에 바로 비교하긴 어렵습니다.'
          : 'autoCandidate는 있으나 아직 관찰 우선입니다.';
    reasons.push(`autoCandidate 검증 ${rows.length}건 (ready ${ready} / observe ${observe} / blocked ${blocked})`);
  }

  if (ready > 0) {
    actionItems.push('ready 후보부터 synthetic/드라이런 비교 실험 큐로 올립니다.');
  }
  if (blocked > 0) {
    actionItems.push('blocked 후보는 runtime top risk reason이 완화될 때까지 보류합니다.');
  }
  if (actionItems.length === 0) {
    actionItems.push('validation 결과를 계속 누적하며 ready 후보가 생기는지 관찰합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: { total: rows.length, ready, observe, blocked },
  };
}

function renderText(payload) {
  const lines = [
    '🧪 Runtime Allow Candidate Validation',
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '후보:',
    ...payload.rows.map((row) =>
      `- ${row.key} | market=${row.market} | readiness=${row.readiness} | reason=${row.reason}`
    ),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ];
  return lines.join('\n');
}

export async function buildRuntimeAllowCandidatesValidation({ days = 14, limit = 20, json = false } = {}) {
  const allowReport = await buildRuntimeAllowCandidatesReport({ days, limit, json: true });
  const autoCandidates = (allowReport.candidates || []).filter((item) => item.autoCandidate);
  const markets = [...new Set(autoCandidates.map((item) => inferMarketFromKey(item.key)))];

  const runtimeByMarket = {};
  const pressureByMarket = {};
  for (const market of markets) {
    runtimeByMarket[market] = await buildRuntimeDecisionSummary({ market, limit: 5, json: true }).catch(() => null);
    if (market === 'domestic' || market === 'overseas') {
      const pressureMarket = market === 'domestic' ? 'kis' : 'kis_overseas';
      pressureByMarket[market] = await buildRuntimeMinOrderPressureReport({ market: pressureMarket, days, json: true }).catch(() => null);
    }
  }

  const rows = autoCandidates.map((candidate) => {
    const market = inferMarketFromKey(candidate.key);
    const runtime = runtimeByMarket[market] || null;
    const pressure = pressureByMarket[market] || null;
    const evaluation = inferReadiness(candidate, runtime, pressure);
    return {
      ...candidate,
      market,
      runtimeStatus: runtime?.decision?.status || 'runtime_unknown',
      topRiskReject: runtime?.decision?.metrics?.topRiskReject?.key || null,
      minOrderPressure: pressure?.decision?.status || null,
      readiness: evaluation.readiness,
      reason: evaluation.reason,
    };
  });

  const decision = buildDecision(rows);
  const payload = {
    ok: true,
    days,
    limit,
    rows,
    runtimeByMarket,
    pressureByMarket,
    decision,
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeAllowCandidatesValidation(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-allow-candidates-validation 오류:',
  });
}
