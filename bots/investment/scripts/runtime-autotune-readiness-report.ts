#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeAllowCandidatesValidation } from './runtime-allow-candidates-validation.ts';
import { buildRuntimePlannerCoverageReport } from './runtime-planner-coverage-report.ts';
import { buildRuntimeMinOrderPressureReport } from './runtime-min-order-pressure-report.ts';
import { buildVectorBtBacktestReport } from './vectorbt-backtest-report.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const limitArg = argv.find((arg) => arg.startsWith('--limit='));
  return {
    days: Math.max(7, Number(daysArg?.split('=')[1] || 14)),
    limit: Math.max(1, Number(limitArg?.split('=')[1] || 20)),
    json: argv.includes('--json'),
  };
}

function buildDecision({ allowValidation, plannerCoverage, minOrderPressure, backtest }) {
  const allowDecision = allowValidation?.decision || {};
  const plannerDecision = plannerCoverage?.decision || {};
  const pressureDecision = minOrderPressure?.decision || {};
  const backtestDecision = backtest?.decision || {};

  let status = 'autotune_waiting';
  let headline = '자동 튜닝 판단에 필요한 관찰 레일을 계속 쌓는 중입니다.';
  const reasons = [];
  const actionItems = [];

  if (plannerDecision.status) {
    reasons.push(`planner coverage: ${plannerDecision.status}`);
  }
  if (allowDecision.status) {
    reasons.push(`allow validation: ${allowDecision.status}`);
  }
  if (pressureDecision.status) {
    reasons.push(`min-order: ${pressureDecision.status}`);
  }
  if (backtestDecision.status) {
    reasons.push(`vectorbt: ${backtestDecision.status}`);
  }

  const readyCandidates = Number(allowDecision.metrics?.ready || 0);
  const plannerReady = plannerDecision.status === 'planner_coverage_ready';
  const minOrderBlocked = String(pressureDecision.status || '').includes('pressure');
  const backtestOk = backtestDecision.status === 'backtest_ok';

  if (readyCandidates > 0 && plannerReady && !minOrderBlocked && backtestOk) {
    status = 'autotune_ready';
    headline = '자동 튜닝 비교 실험을 시작할 준비가 됐습니다.';
    actionItems.push('ready allow 후보부터 synthetic 비교 실험 큐로 올립니다.');
  } else if (plannerReady && minOrderBlocked) {
    status = 'autotune_blocked';
    headline = 'planner/validation 레일은 준비됐지만 최소 주문 병목이 자동 튜닝을 막고 있습니다.';
    actionItems.push('국내장 최소 주문 병목을 완화하거나 별도 예외 시장으로 분리합니다.');
  } else if (plannerReady) {
    status = 'autotune_observe';
    headline = 'planner 레일은 준비됐고, 이제 ready allow 후보나 backtest 품질을 더 쌓아야 합니다.';
    actionItems.push('allow validation에서 ready 후보가 생기는지 계속 누적합니다.');
  } else {
    actionItems.push('planner attach 비율과 allow validation 상태를 계속 누적합니다.');
  }

  if (backtestDecision.status !== 'backtest_ok') {
    actionItems.push('VectorBT 결과 품질/이슈를 같이 보며 전략 변경 안전장치를 유지합니다.');
  }
  if (actionItems.length === 0) {
    actionItems.push('현재 관찰 레일을 유지하면서 다음 비교 시점을 기다립니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      readyCandidates,
      plannerReady,
      minOrderBlocked,
      backtestOk,
    },
  };
}

function renderText(payload) {
  const lines = [
    '🧠 Runtime Autotune Readiness',
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '핵심 지표:',
    `- readyCandidates: ${payload.decision.metrics.readyCandidates}`,
    `- plannerReady: ${payload.decision.metrics.plannerReady ? 'yes' : 'no'}`,
    `- minOrderBlocked: ${payload.decision.metrics.minOrderBlocked ? 'yes' : 'no'}`,
    `- backtestOk: ${payload.decision.metrics.backtestOk ? 'yes' : 'no'}`,
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ];
  return lines.join('\n');
}

export async function buildRuntimeAutotuneReadinessReport({ days = 14, limit = 20, json = false } = {}) {
  const [allowValidation, plannerCoverage, minOrderPressure, backtest] = await Promise.all([
    buildRuntimeAllowCandidatesValidation({ days, limit, json: true }).catch(() => null),
    buildRuntimePlannerCoverageReport({ limit: 5, json: true }).catch(() => null),
    buildRuntimeMinOrderPressureReport({ market: 'kis', days, json: true }).catch(() => null),
    buildVectorBtBacktestReport({ days: 30, limit: 20, json: true }).catch(() => null),
  ]);

  const decision = buildDecision({
    allowValidation,
    plannerCoverage,
    minOrderPressure,
    backtest,
  });

  const payload = {
    ok: true,
    days,
    limit,
    allowValidation,
    plannerCoverage,
    minOrderPressure,
    backtest,
    decision,
  };

  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeAutotuneReadinessReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-autotune-readiness-report 오류:',
  });
}
