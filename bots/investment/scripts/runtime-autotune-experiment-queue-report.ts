#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';
import { buildRuntimeAutotuneReadinessReport } from './runtime-autotune-readiness-report.ts';
import { buildRuntimeAllowCandidatesValidation } from './runtime-allow-candidates-validation.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  const limitArg = argv.find((arg) => arg.startsWith('--limit='));
  return {
    days: Math.max(7, Number(daysArg?.split('=')[1] || 14)),
    limit: Math.max(1, Number(limitArg?.split('=')[1] || 20)),
    json: argv.includes('--json'),
  };
}

function buildQueueRows(validation = null) {
  return (validation?.rows || [])
    .filter((row) => row.readiness === 'ready')
    .map((row, index) => ({
      rank: index + 1,
      key: row.key,
      market: row.market,
      governanceTier: row.governance?.tier || 'unknown',
      label: row.governance?.label || row.key,
      current: row.current,
      suggested: row.suggested,
      action: row.action,
      confidence: row.confidence,
      runtimeStatus: row.runtimeStatus || 'runtime_unknown',
      reason: row.reason,
    }));
}

function buildDecision(queueRows = [], readiness = null) {
  const readinessDecision = readiness?.decision || {};
  const metrics = readinessDecision.metrics || {};

  let status = 'autotune_queue_idle';
  let headline = '비교 실험 큐로 올릴 ready 후보가 아직 없습니다.';
  const reasons = [];
  const actionItems = [];

  if (readinessDecision.status) {
    reasons.push(`autotune readiness: ${readinessDecision.status}`);
  }
  if (queueRows.length > 0) {
    status = 'autotune_queue_ready';
    headline = 'ready allow 후보가 비교 실험 큐에 올라갈 준비가 됐습니다.';
    reasons.push(`ready queue ${queueRows.length}건`);
    actionItems.push('rank 1 후보부터 dry-run 비교 실험으로 검토합니다.');
  } else if (metrics.readyCandidates > 0) {
    status = 'autotune_queue_pending';
    headline = 'ready 후보는 있지만 큐 정리 기준을 더 확인해야 합니다.';
    reasons.push(`readyCandidates ${metrics.readyCandidates}건`);
    actionItems.push('validation rows의 runtime 상태와 suggested 값을 다시 검토합니다.');
  } else {
    actionItems.push('ready 후보가 생길 때까지 validation/autotune 레일을 계속 누적합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      queued: queueRows.length,
      readyCandidates: Number(metrics.readyCandidates || 0),
    },
  };
}

function renderText(payload) {
  const lines = [
    '🧪 Runtime Autotune Experiment Queue',
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    payload.aiSummary ? `🔍 AI: ${payload.aiSummary}` : null,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '큐:',
    ...(payload.queueRows.length
      ? payload.queueRows.map((row) =>
          `- #${row.rank} ${row.key} | market=${row.market} | current=${row.current} | suggested=${row.suggested} | confidence=${row.confidence} | runtime=${row.runtimeStatus}`,
        )
      : ['- ready 후보 없음']),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ];
  return lines.filter(Boolean).join('\n');
}

function buildFallback(payload = {}) {
  const decision = payload.decision || {};
  const metrics = decision.metrics || {};
  if (decision.status === 'autotune_queue_ready') {
    return `ready allow 후보 ${metrics.queued || 0}건이 비교 실험 큐에 올라와 있어 rank 1부터 dry-run으로 검토하면 됩니다.`;
  }
  if (decision.status === 'autotune_queue_pending') {
    return `ready 후보 ${metrics.readyCandidates || 0}건이 있어 큐 정리 기준만 점검하면 바로 비교 실험으로 넘어갈 수 있습니다.`;
  }
  return '지금은 비교 실험 큐에 올릴 ready 후보가 없어 validation/autotune 레일을 계속 누적하는 편이 좋습니다.';
}

export async function buildRuntimeAutotuneExperimentQueueReport({ days = 14, limit = 20, json = false } = {}) {
  const [readiness, validation] = await Promise.all([
    buildRuntimeAutotuneReadinessReport({ days, limit, json: true }).catch(() => null),
    buildRuntimeAllowCandidatesValidation({ days, limit, json: true }).catch(() => null),
  ]);

  const queueRows = buildQueueRows(validation);
  const decision = buildDecision(queueRows, readiness);
  const payload = {
    ok: true,
    days,
    limit,
    readiness,
    validation,
    queueRows,
    decision,
  };

  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-autotune-experiment-queue-report',
    requestType: 'runtime-autotune-experiment-queue-report',
    title: '투자 runtime autotune experiment queue 리포트 요약',
    data: {
      days,
      limit,
      queueRows,
      decision,
      readiness: readiness?.decision,
    },
    fallback: buildFallback(payload),
  });

  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeAutotuneExperimentQueueReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-autotune-experiment-queue-report 오류:',
  });
}
