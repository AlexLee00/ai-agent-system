#!/usr/bin/env node
// @ts-nocheck

import { createRequire } from 'module';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimePlannerCoverageReport } from './runtime-planner-coverage-report.ts';
import { buildRuntimeAutotuneReadinessReport } from './runtime-autotune-readiness-report.ts';
import { buildRuntimeMinOrderReliefReport } from './runtime-min-order-relief-report.ts';
import { buildRuntimeEscalateCandidatesReport } from './runtime-escalate-candidates-report.ts';
import { buildVectorBtBacktestReport } from './vectorbt-backtest-report.ts';

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
  const rows = buildServiceRows({
    allServices: ALL_SERVICES,
    continuousServices: CONTINUOUS,
    launchctlStatus: launchctl,
    normalExitCodes: DEFAULT_NORMAL_EXIT_CODES,
    shortLabel: (label) => label.replace(/^ai\.investment\./, ''),
  });
  const okCount = rows.filter((row) => row.status === 'ok').length;
  const warnCount = rows.filter((row) => row.status !== 'ok').length;
  return {
    ok: true,
    serviceHealth: {
      okCount,
      warnCount,
      rows,
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

function buildDecision({ health, plannerCoverage, autotune, relief, escalate, backtest }) {
  const reasons = [];
  const actionItems = [];

  const healthOk = Boolean(health?.serviceHealth?.okCount >= 10 && Number(health?.serviceHealth?.warnCount || 0) === 0);
  const plannerReady = plannerCoverage?.decision?.status === 'planner_coverage_ready';
  const autotuneBlocked = autotune?.decision?.status === 'autotune_blocked';
  const reliefBlocked = relief?.decision?.status === 'relief_blocked_by_order_cap';
  const escalateBlocked = escalate?.decision?.status === 'escalate_blocked';
  const backtestOk = backtest?.decision?.status === 'backtest_ok';

  if (health?.serviceHealth) {
    reasons.push(`health: ok ${health.serviceHealth.okCount} / warn ${health.serviceHealth.warnCount}`);
  }
  if (plannerCoverage?.decision?.status) reasons.push(`planner: ${plannerCoverage.decision.status}`);
  if (autotune?.decision?.status) reasons.push(`autotune: ${autotune.decision.status}`);
  if (relief?.decision?.status) reasons.push(`min-order relief: ${relief.decision.status}`);
  if (escalate?.decision?.status) reasons.push(`escalate: ${escalate.decision.status}`);
  if (backtest?.decision?.status) reasons.push(`vectorbt: ${backtest.decision.status}`);

  let status = 'remodel_in_progress';
  let headline = '리모델링이 거의 닫혔지만, 아직 운영 승인/정책 결정이 남아 있습니다.';

  if (healthOk && plannerReady && backtestOk && !autotuneBlocked && !reliefBlocked && !escalateBlocked) {
    status = 'remodel_ready_to_close';
    headline = '리모델링 닫힘 기준에 도달했습니다.';
    actionItems.push('잔여 승인 항목이 없으면 closeout 문서와 최종 운영 전환만 정리합니다.');
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
  if (!plannerReady) {
    actionItems.push('실세션 planner attach ratio를 더 누적합니다.');
  }
  if (!backtestOk) {
    actionItems.push('VectorBT 결과 품질을 먼저 회복합니다.');
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
    },
  };
}

function renderText(payload) {
  const m = payload.decision.metrics || {};
  return [
    '🧩 Luna Remodel Closeout',
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
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
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ].join('\n');
}

export async function buildRemodelCloseoutReport({ days = 14, json = false } = {}) {
  const [plannerCoverage, autotune, relief, escalate, backtest, health] = await Promise.all([
    buildRuntimePlannerCoverageReport({ limit: 5, json: true }).catch(() => null),
    buildRuntimeAutotuneReadinessReport({ days, limit: 20, json: true }).catch(() => null),
    buildRuntimeMinOrderReliefReport({ days, json: true }).catch(() => null),
    buildRuntimeEscalateCandidatesReport({ days, json: true }).catch(() => null),
    buildVectorBtBacktestReport({ days: 30, limit: 20, json: true }).catch(() => null),
    Promise.resolve().then(() => buildLightHealthReport()).catch(() => null),
  ]);

  const decision = buildDecision({
    health,
    plannerCoverage,
    autotune,
    relief,
    escalate,
    backtest,
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
    decision,
  };

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
