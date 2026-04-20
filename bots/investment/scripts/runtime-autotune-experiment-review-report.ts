#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';
import { buildRuntimeAutotuneExperimentQueueReport } from './runtime-autotune-experiment-queue-report.ts';
import { buildRuntimeDecisionSummary } from './runtime-decision-summary.ts';
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

function classifyExperiment(row) {
  const sameValue = Number(row.current) === Number(row.suggested);
  if (sameValue && row.action === 'promote_candidate') {
    return {
      type: 'promotion_review',
      label: '승격 검토',
      summary: '설정값 자체를 바꾸기보다 validation 근거를 normal 운영으로 승격할지 검토하는 후보입니다.',
    };
  }
  if (!sameValue) {
    return {
      type: 'config_diff_dry_run',
      label: '설정 비교 실험',
      summary: '현재값과 제안값 차이를 dry-run으로 비교할 수 있는 후보입니다.',
    };
  }
  return {
    type: 'observe_only',
    label: '관찰 유지',
    summary: '즉시 바꿀 값 차이가 없어 추가 표본 누적이 우선입니다.',
  };
}

function buildDecision(queueRows = [], runtime = null, backtest = null) {
  const first = queueRows[0] || null;
  if (!first) {
    return {
      status: 'experiment_review_idle',
      headline: '검토할 실험 후보가 아직 없습니다.',
      reasons: [],
      actionItems: ['ready 후보가 생길 때까지 experiment queue를 계속 누적합니다.'],
      metrics: {
        queueSize: 0,
      },
    };
  }

  const experiment = classifyExperiment(first);
  const runtimeDecision = runtime?.decision || {};
  const backtestDecision = backtest?.decision || {};

  const reasons = [
    `rank1: ${first.key}`,
    `experiment type: ${experiment.type}`,
    `runtime: ${runtimeDecision.status || 'unknown'}`,
    `backtest: ${backtestDecision.status || 'unknown'}`,
  ];
  const actionItems = [];
  let status = 'experiment_review_ready';
  let headline = `${experiment.label} 대상으로 dry-run 검토를 시작할 수 있습니다.`;

  if (experiment.type === 'promotion_review') {
    actionItems.push('validation 체결 근거와 normal 실행 부재를 같이 비교해 승격 필요성을 검토합니다.');
    actionItems.push('즉시 config 값을 바꾸지 말고, normal lane 적용 여부를 별도 실험안으로 정리합니다.');
  } else if (experiment.type === 'config_diff_dry_run') {
    actionItems.push('current/suggested 차이를 기준으로 synthetic 비교 실험안을 만듭니다.');
  } else {
    status = 'experiment_review_observe';
    headline = 'ready 후보는 있지만 값 차이가 없어 관찰 우선입니다.';
    actionItems.push('추가 표본이 더 쌓일 때까지 현재 후보를 관찰합니다.');
  }

  if (runtimeDecision.metrics?.executedSymbols === 0) {
    actionItems.push('approved 대비 executed=0 원인을 함께 기록해 실험 판단에 반영합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      queueSize: queueRows.length,
      experimentType: experiment.type,
      rank1Key: first.key,
    },
    rank1: {
      ...first,
      experiment,
    },
  };
}

function renderText(payload) {
  const rank1 = payload.decision.rank1;
  const lines = [
    '🧪 Runtime Autotune Experiment Review',
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
          `- type: ${rank1.experiment.label} (${rank1.experiment.type})`,
          `- current/suggested: ${rank1.current} -> ${rank1.suggested}`,
          `- summary: ${rank1.experiment.summary}`,
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
  const rank1 = decision.rank1 || null;
  if (!rank1) {
    return '지금은 검토할 ready 후보가 없어 experiment queue를 더 누적하는 편이 좋습니다.';
  }
  if (rank1.experiment?.type === 'promotion_review') {
    return 'rank 1 후보는 값 변경보다 승격 검토 타입이라, validation 근거를 normal 운영으로 넘길지 먼저 보는 편이 좋습니다.';
  }
  if (rank1.experiment?.type === 'config_diff_dry_run') {
    return 'rank 1 후보는 값 차이가 있어 current/suggested 비교 실험을 바로 시작할 수 있습니다.';
  }
  return '현재 rank 1 후보는 값 차이가 없어 관찰을 더 누적하는 편이 좋습니다.';
}

export async function buildRuntimeAutotuneExperimentReviewReport({ days = 14, limit = 20, json = false } = {}) {
  const queue = await buildRuntimeAutotuneExperimentQueueReport({ days, limit, json: true }).catch(() => null);
  const first = queue?.queueRows?.[0] || null;
  const runtime = first?.market
    ? await buildRuntimeDecisionSummary({ market: first.market, limit: 5, json: true }).catch(() => null)
    : null;
  const backtest = await buildVectorBtBacktestReport({ days: 30, limit: 20, json: true }).catch(() => null);

  const decision = buildDecision(queue?.queueRows || [], runtime, backtest);
  const payload = {
    ok: true,
    days,
    limit,
    queue,
    runtime,
    backtest,
    decision,
  };

  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-autotune-experiment-review-report',
    requestType: 'runtime-autotune-experiment-review-report',
    title: '투자 runtime autotune experiment review 리포트 요약',
    data: {
      days,
      limit,
      decision,
      queueDecision: queue?.decision,
      runtimeDecision: runtime?.decision,
    },
    fallback: buildFallback(payload),
  });

  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeAutotuneExperimentReviewReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-autotune-experiment-review-report 오류:',
  });
}
