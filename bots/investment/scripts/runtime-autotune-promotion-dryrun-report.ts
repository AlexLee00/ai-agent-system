#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';
import { buildRuntimeAutotuneExperimentReviewReport } from './runtime-autotune-experiment-review-report.ts';
import { buildRuntimeDecisionSummary } from './runtime-decision-summary.ts';
import { buildRuntimeKisOrderPressureReport } from './runtime-kis-order-pressure-report.ts';
import { buildRuntimeKisReentryPressureReport } from './runtime-kis-reentry-pressure-report.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const limitArg = argv.find((arg) => arg.startsWith('--limit='));
  return {
    days: Math.max(7, Number(daysArg?.split('=')[1] || 14)),
    limit: Math.max(1, Number(limitArg?.split('=')[1] || 20)),
    json: argv.includes('--json'),
  };
}

function buildDecision({ review, runtime, orderPressure, reentryPressure }) {
  const rank1 = review?.decision?.rank1 || null;
  const runtimeDecision = runtime?.decision || {};
  const orderDecision = orderPressure?.decision || {};
  const reentryDecision = reentryPressure?.decision || {};

  if (!rank1) {
    return {
      status: 'promotion_dryrun_idle',
      headline: '검토할 승격 후보가 아직 없습니다.',
      reasons: [],
      actionItems: ['rank 1 승격 후보가 생길 때까지 experiment review 레일을 계속 누적합니다.'],
      metrics: {
        approvedSignals: 0,
        executedSymbols: 0,
        orderPressure: 'unknown',
        reentryPressure: 'unknown',
      },
    };
  }

  const approvedSignals = Number(runtimeDecision.metrics?.approvedSignals || 0);
  const executedSymbols = Number(runtimeDecision.metrics?.executedSymbols || 0);
  const orderStatus = String(orderDecision.status || 'unknown');
  const reentryStatus = String(reentryDecision.status || 'unknown');

  let status = 'promotion_dryrun_ready';
  let headline = '승격 후보를 normal 운영 관점에서 dry-run 검토할 수 있습니다.';
  const reasons = [
    `rank1 후보: ${rank1.key}`,
    `validation 근거: ${rank1.label}`,
    `normal runtime approved ${approvedSignals} / executed ${executedSymbols}`,
    `주문 압력: ${orderStatus}`,
    `재진입 압력: ${reentryStatus}`,
  ];
  const actionItems = [
    '승격 적용 전, normal lane에서 approved 대비 executed=0 원인을 함께 검토합니다.',
  ];

  if (executedSymbols === 0 && approvedSignals > 0) {
    actionItems.push('승격 자체보다 execution gate 해소가 먼저 필요한지 같이 판단합니다.');
  }
  if (orderStatus === 'kis_order_pressure') {
    status = 'promotion_dryrun_blocked';
    headline = '국내장 주문 초과 압력이 커서 승격 전 주문 산정 안정화가 우선입니다.';
    actionItems.push('주문 수량/금액 초과 압력이 먼저 줄어드는지 확인합니다.');
  } else if (reentryStatus === 'kis_reentry_pressure') {
    status = 'promotion_dryrun_blocked';
    headline = '국내장 재진입 차단 압력이 커서 승격 전 포지션 정책 점검이 우선입니다.';
    actionItems.push('동일 포지션/당일 재진입 차단 정책을 먼저 점검합니다.');
  } else {
    actionItems.push('주문/재진입 압력이 watch 이하이므로 승격 dry-run 비교안을 만들 수 있습니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      approvedSignals,
      executedSymbols,
      orderPressure: orderStatus,
      reentryPressure: reentryStatus,
    },
    rank1,
  };
}

function renderText(payload) {
  const rank1 = payload.decision.rank1;
  const lines = [
    '🧪 Runtime Autotune Promotion Dry Run',
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    payload.aiSummary ? `🔍 AI: ${payload.aiSummary}` : null,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    'rank 1:',
    ...(rank1
      ? [
          `- key: ${rank1.key}`,
          `- label: ${rank1.label}`,
          `- current/suggested: ${rank1.current} -> ${rank1.suggested}`,
          `- runtimeStatus: ${rank1.runtimeStatus}`,
        ]
      : ['- 후보 없음']),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ];
  return lines.filter(Boolean).join('\n');
}

function buildFallback(payload = {}) {
  const decision = payload.decision || {};
  if (decision.status === 'promotion_dryrun_blocked') {
    return '승격 후보는 있지만 국내장 주문/재진입 압력을 먼저 보는 편이 좋습니다.';
  }
  if (decision.status === 'promotion_dryrun_ready') {
    return '국내장 승격 후보를 normal 운영 관점에서 dry-run으로 검토할 준비가 됐습니다.';
  }
  return '지금은 검토할 승격 후보가 없어 experiment review를 더 누적하는 편이 좋습니다.';
}

export async function buildRuntimeAutotunePromotionDryRunReport({ days = 14, limit = 20, json = false } = {}) {
  const review = await buildRuntimeAutotuneExperimentReviewReport({ days, limit, json: true }).catch(() => null);
  const rank1 = review?.decision?.rank1 || null;
  const runtime = rank1?.market
    ? await buildRuntimeDecisionSummary({ market: rank1.market, limit: 5, json: true }).catch(() => null)
    : null;
  const [orderPressure, reentryPressure] = await Promise.all([
    buildRuntimeKisOrderPressureReport({ days, json: true }).catch(() => null),
    buildRuntimeKisReentryPressureReport({ days, json: true }).catch(() => null),
  ]);

  const decision = buildDecision({ review, runtime, orderPressure, reentryPressure });
  const payload = {
    ok: true,
    days,
    limit,
    review,
    runtime,
    orderPressure,
    reentryPressure,
    decision,
  };

  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-autotune-promotion-dryrun-report',
    requestType: 'runtime-autotune-promotion-dryrun-report',
    title: '투자 runtime autotune promotion dry-run 리포트 요약',
    data: {
      days,
      limit,
      decision,
      reviewDecision: review?.decision,
      runtimeDecision: runtime?.decision,
      orderPressure: orderPressure?.decision,
      reentryPressure: reentryPressure?.decision,
    },
    fallback: buildFallback(payload),
  });

  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeAutotunePromotionDryRunReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-autotune-promotion-dryrun-report 오류:',
  });
}
