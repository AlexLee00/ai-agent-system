#!/usr/bin/env node
// @ts-nocheck

import { createRequire } from 'module';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimePlannerCoverageReport } from './runtime-planner-coverage-report.ts';
import { buildRuntimeAutotuneReadinessReport } from './runtime-autotune-readiness-report.ts';
import { buildRuntimeMinOrderReliefReport } from './runtime-min-order-relief-report.ts';
import { buildRuntimeEscalateCandidatesReport } from './runtime-escalate-candidates-report.ts';
import { buildVectorBtBacktestReport } from './vectorbt-backtest-report.ts';
import { buildTradeReviewRepairCloseout, validateTradeReview } from './validate-trade-review.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';

const require = createRequire(import.meta.url);
const {
  DEFAULT_NORMAL_EXIT_CODES,
  getLaunchctlStatus,
  buildServiceRows,
} = require('../../../packages/core/lib/health-provider');

const CONTINUOUS = [
  'ai.investment.commander',
];

const ALL_SERVICES = [
  'ai.investment.commander',
  'ai.investment.crypto',
  'ai.investment.domestic',
  'ai.investment.overseas',
  'ai.investment.argos',
  'ai.investment.market-alert-crypto-daily',
  'ai.investment.market-alert-domestic-open',
  'ai.investment.market-alert-domestic-close',
  'ai.investment.market-alert-overseas-open',
  'ai.investment.market-alert-overseas-close',
  'ai.investment.prescreen-domestic',
  'ai.investment.prescreen-overseas',
  'ai.investment.reporter',
];

function buildLightHealthReport() {
  const launchctl = getLaunchctlStatus();
  const built = buildServiceRows(launchctl, {
    labels: ALL_SERVICES,
    continuous: CONTINUOUS,
    normalExitCodes: DEFAULT_NORMAL_EXIT_CODES,
    shortLabel: (label) => label.replace(/^ai\.investment\./, ''),
  });
  const okRows = Array.isArray(built?.ok) ? built.ok : [];
  const warnRows = Array.isArray(built?.warn) ? built.warn : [];
  const rows = [
    ...okRows.map((detail) => ({ status: 'ok', detail })),
    ...warnRows.map((detail) => ({ status: 'warn', detail })),
  ];
  const okCount = okRows.length;
  const warnCount = warnRows.length;
  return {
    ok: true,
    serviceHealth: {
      okCount,
      warnCount,
      rows,
      ok: okRows,
      warn: warnRows,
    },
  };
}

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(7, Number(daysArg?.split('=')[1] || 14)),
    json: argv.includes('--json'),
  };
}

export function buildDecision({ health, plannerCoverage, autotune, relief, escalate, backtest, tradeReview, reviewRepairCloseout }) {
  const reasons = [];
  const actionItems = [];

  const healthOk = Boolean(health?.serviceHealth?.okCount >= 10 && Number(health?.serviceHealth?.warnCount || 0) === 0);
  const plannerReady = plannerCoverage?.decision?.status === 'planner_coverage_ready';
  const autotuneBlocked = ['autotune_blocked', 'autotune_waiting_sizing_floor'].includes(String(autotune?.decision?.status || ''));
  const reliefBlocked = relief?.decision?.status === 'relief_blocked_by_order_cap';
  const escalateBlocked = escalate?.decision?.status === 'escalate_blocked';
  const backtestOk = backtest?.decision?.status === 'backtest_ok';
  const tradeReviewLiveFindings = Number(tradeReview?.summary?.liveFindings || 0);
  const tradeReviewPaperFindings = Number(tradeReview?.summary?.paperFindings || 0);
  const tradeReviewPaperOnly = Boolean(tradeReview?.summary?.paperOnly && tradeReviewPaperFindings > 0);
  const tradeReviewLiveOk = tradeReviewLiveFindings === 0;
  const tradeReviewPaperRepair = tradeReviewPaperOnly;

  if (health?.serviceHealth) {
    reasons.push(`health: ok ${health.serviceHealth.okCount} / warn ${health.serviceHealth.warnCount}`);
  }
  if (plannerCoverage?.decision?.status) reasons.push(`planner: ${plannerCoverage.decision.status}`);
  if (autotune?.decision?.status) reasons.push(`autotune: ${autotune.decision.status}`);
  if (relief?.decision?.status) reasons.push(`min-order relief: ${relief.decision.status}`);
  if (escalate?.decision?.status) reasons.push(`escalate: ${escalate.decision.status}`);
  if (backtest?.decision?.status) reasons.push(`vectorbt: ${backtest.decision.status}`);
  if (tradeReview?.summary) {
    reasons.push(`trade review: live ${tradeReviewLiveFindings} / paper ${tradeReviewPaperFindings}`);
  }
  if (reviewRepairCloseout?.status) {
    reasons.push(`trade review closeout: ${reviewRepairCloseout.status} / liveSafe ${reviewRepairCloseout.liveSafe ? 'yes' : 'no'}`);
  }

  let status = 'remodel_in_progress';
  let headline = '리모델링이 거의 닫혔지만, 아직 운영 승인/정책 결정이 남아 있습니다.';

  if (healthOk && plannerReady && backtestOk && tradeReviewLiveOk && !autotuneBlocked && !reliefBlocked && !escalateBlocked) {
    status = 'remodel_ready_to_close';
    headline = '리모델링 닫힘 기준에 도달했습니다.';
    actionItems.push('잔여 승인 항목이 없으면 closeout 문서와 최종 운영 전환만 정리합니다.');
  } else if (healthOk && plannerReady && backtestOk && !tradeReviewLiveOk) {
    status = 'remodel_data_integrity_needed';
    headline = 'live trade_review 정합성 이슈가 남아 있어 운영 전환 전에 복구가 필요합니다.';
    actionItems.push(tradeReview?.summary?.repairCommand || 'live trade_review 정합성 이슈를 먼저 복구합니다.');
  } else if (healthOk && plannerReady && backtestOk && escalateBlocked) {
    status = 'remodel_waiting_approval';
    headline = '코드/관찰 레일은 충분하지만 운영 승인 또는 정책 결정이 남아 있습니다.';
    actionItems.push('policy-blocked 항목과 approval-needed 항목을 운영 승인 큐로 분리합니다.');
  } else {
    actionItems.push('health / planner / autotune / backtest 기준선을 계속 누적합니다.');
  }

  if (reliefBlocked) {
    actionItems.push('국내장 주문 상한(maxOrder) 이슈는 allow 조정이 아니라 정책 결정 항목으로 다룹니다.');
  }
  if (autotune?.decision?.status === 'autotune_waiting_sizing_floor') {
    actionItems.push('국내장 최소 주문 미만으로 잘리는 후보는 autotune이 아니라 최종 sizing floor 정책으로 먼저 정리합니다.');
  }
  if (!plannerReady) {
    actionItems.push('실세션 planner attach ratio를 더 누적합니다.');
  }
  if (!backtestOk) {
    actionItems.push('VectorBT 결과 품질을 먼저 회복합니다.');
  }
  if (tradeReviewPaperRepair) {
    actionItems.push(`paper-only trade_review 복구는 live 전환 병목이 아니며 별도 closeout으로 정리합니다: ${tradeReview?.summary?.repairCommand || 'validate-review:repair:paper'}`);
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      healthOk,
      plannerReady,
      autotuneBlocked,
      reliefBlocked,
      escalateBlocked,
      backtestOk,
      tradeReviewLiveOk,
      tradeReviewPaperRepair,
      tradeReviewLiveFindings,
      tradeReviewPaperFindings,
    },
  };
}

function renderText(payload) {
  const m = payload.decision.metrics || {};
  return [
    '🧩 Luna Remodel Closeout',
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    payload.aiSummary ? `🔍 AI: ${payload.aiSummary}` : null,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '핵심 지표:',
    `- healthOk: ${m.healthOk ? 'yes' : 'no'}`,
    `- plannerReady: ${m.plannerReady ? 'yes' : 'no'}`,
    `- autotuneBlocked: ${m.autotuneBlocked ? 'yes' : 'no'}`,
    `- reliefBlocked: ${m.reliefBlocked ? 'yes' : 'no'}`,
    `- escalateBlocked: ${m.escalateBlocked ? 'yes' : 'no'}`,
    `- backtestOk: ${m.backtestOk ? 'yes' : 'no'}`,
    `- tradeReviewLiveOk: ${m.tradeReviewLiveOk ? 'yes' : 'no'}`,
    `- tradeReviewPaperRepair: ${m.tradeReviewPaperRepair ? 'yes' : 'no'}`,
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ].filter(Boolean).join('\n');
}

function buildCloseoutFallback(payload) {
  const decision = payload?.decision || {};
  const metrics = decision.metrics || {};
  if (decision.status === 'remodel_ready_to_close') {
    return '리모델링 닫힘 기준에 거의 도달해, 남은 운영 전환과 closeout 문서만 정리하면 됩니다.';
  }
  if (decision.status === 'remodel_waiting_approval') {
    return '코드와 관찰 레일은 충분하지만, policy-blocked 또는 approval-needed 항목이 남아 운영 판단이 필요합니다.';
  }
  if (decision.status === 'remodel_data_integrity_needed') {
    return `live trade_review 정합성 이슈 ${Number(metrics.tradeReviewLiveFindings || 0)}건이 남아, 운영 전환 전 복구가 필요합니다.`;
  }
  return `리모델링은 아직 진행 중이며, health=${metrics.healthOk ? 'ok' : 'watch'}, planner=${metrics.plannerReady ? 'ready' : 'watch'}, backtest=${metrics.backtestOk ? 'ok' : 'watch'} 축을 계속 누적해야 합니다.`;
}

export async function buildRemodelCloseoutReport({ days = 14, json = false } = {}) {
  const [plannerCoverage, autotune, relief, escalate, backtest, health, tradeReview] = await Promise.all([
    buildRuntimePlannerCoverageReport({ limit: 5, json: true }).catch(() => null),
    buildRuntimeAutotuneReadinessReport({ days, limit: 20, json: true }).catch(() => null),
    buildRuntimeMinOrderReliefReport({ days, json: true }).catch(() => null),
    buildRuntimeEscalateCandidatesReport({ days, json: true }).catch(() => null),
    buildVectorBtBacktestReport({ days: 30, limit: 20, json: true }).catch(() => null),
    Promise.resolve().then(() => buildLightHealthReport()).catch(() => null),
    validateTradeReview({ days: 90, fix: false }).catch(() => null),
  ]);
  const reviewRepairCloseout = tradeReview
    ? buildTradeReviewRepairCloseout({ before: tradeReview, after: tradeReview, fix: false })
    : null;

  const decision = buildDecision({
    health,
    plannerCoverage,
    autotune,
    relief,
    escalate,
    backtest,
    tradeReview,
    reviewRepairCloseout,
  });

  const payload = {
    ok: true,
    days,
    plannerCoverage,
    autotune,
    relief,
    escalate,
    backtest,
    health,
    tradeReview,
    reviewRepairCloseout,
    decision,
  };
  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'remodel-closeout-report',
    requestType: 'remodel-closeout-report',
    title: '루나 리모델 closeout 요약',
    data: {
      days,
      decision,
      plannerStatus: plannerCoverage?.decision?.status,
      autotuneStatus: autotune?.decision?.status,
      reliefStatus: relief?.decision?.status,
      escalateStatus: escalate?.decision?.status,
      backtestStatus: backtest?.decision?.status,
      healthWarnCount: health?.serviceHealth?.warnCount,
      tradeReviewLiveFindings: decision.metrics.tradeReviewLiveFindings,
      tradeReviewPaperFindings: decision.metrics.tradeReviewPaperFindings,
      reviewRepairStatus: reviewRepairCloseout?.status,
      reviewRepairLiveSafe: reviewRepairCloseout?.liveSafe,
    },
    fallback: buildCloseoutFallback(payload),
  });

  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRemodelCloseoutReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ remodel-closeout-report 오류:',
  });
}
