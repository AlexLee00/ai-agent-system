#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildInvestmentCliInsight } from '../shared/cli-insight.ts';
import { getParameterGovernance } from '../shared/runtime-parameter-governance.ts';
import { buildRuntimeAutotuneReadinessReport } from './runtime-autotune-readiness-report.ts';
import { buildRuntimeMinOrderReliefReport } from './runtime-min-order-relief-report.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(7, Number(daysArg?.split('=')[1] || 14)),
    json: argv.includes('--json'),
  };
}

function buildCandidates({ autotune, relief }) {
  const rows = [];
  const reliefDecision = relief?.decision || {};
  const reliefMetrics = reliefDecision.metrics || {};

  if (autotune?.decision?.status === 'autotune_blocked' && reliefDecision.status === 'relief_blocked_by_order_cap') {
    rows.push({
      key: 'runtime_config.luna.stockOrderDefaults.kis.max',
      label: '국내장 주문 상한',
      governance: getParameterGovernance('order_rules'),
      current: reliefMetrics.maxOrder || null,
      required: reliefMetrics.required || null,
      candidate: reliefMetrics.required || null,
      reason: '국내장 min-order 병목이 starterApprove가 아니라 maxOrder cap에 직접 걸립니다.',
      escalationKind: 'order_cap_review',
      blockedByPolicy: true,
      requiresApproval: true,
    });
  }

  if (String(reliefDecision.status || '').includes('blocked') && Number(reliefMetrics.gap || 0) > 0) {
    rows.push({
      key: 'capital_management.max_drawdown_pct',
      label: '운영 정책 재검토',
      governance: getParameterGovernance('capital_management.max_drawdown_pct'),
      current: getParameterGovernance('capital_management.max_drawdown_pct').current,
      required: null,
      candidate: null,
      reason: '현재 병목은 리스크 한도 자체보다 주문 규칙 cap이어서 운영 승인 단위의 재설계가 필요합니다.',
      escalationKind: 'ops_policy_review',
      blockedByPolicy: false,
      requiresApproval: true,
    });
  }

  return rows;
}

function buildDecision(rows = [], autotune = null) {
  const blockedByPolicy = rows.filter((row) => row.blockedByPolicy).length;
  const approvalNeeded = rows.filter((row) => row.requiresApproval).length;

  let status = 'escalate_idle';
  let headline = '즉시 올릴 escalate 후보가 없습니다.';
  const reasons = [];
  const actionItems = [];

  if (rows.length > 0) {
    status = blockedByPolicy > 0 ? 'escalate_blocked' : 'escalate_ready';
    headline =
      blockedByPolicy > 0
        ? 'allow 레일로는 못 푸는 항목이 있어 운영 승인/정책 결정이 필요합니다.'
        : '승인 검토가 필요한 escalate 후보가 준비됐습니다.';
    reasons.push(`escalate 후보 ${rows.length}건 (approval ${approvalNeeded} / policy-blocked ${blockedByPolicy})`);
  }

  if (autotune?.decision?.status) {
    reasons.push(`autotune 상태: ${autotune.decision.status}`);
  }

  if (blockedByPolicy > 0) {
    actionItems.push('order_rules / 주문 상한처럼 block 축에 걸린 항목은 allow 자동조정이 아니라 운영 승인 이슈로 분리합니다.');
  }
  if (approvalNeeded > 0) {
    actionItems.push('승인 필요 후보는 운영 판단 문맥과 함께 별도 에스컬레이션 큐에 올립니다.');
  }
  if (actionItems.length === 0) {
    actionItems.push('현재는 allow 후보와 autotune readiness를 계속 누적합니다.');
  }

  return {
    status,
    headline,
    reasons,
    actionItems,
    metrics: {
      total: rows.length,
      approvalNeeded,
      blockedByPolicy,
    },
  };
}

function renderText(payload) {
  return [
    '🟡 Runtime Escalate Candidates',
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    payload.aiSummary ? `🔍 AI: ${payload.aiSummary}` : null,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    '',
    '후보:',
    ...(payload.rows.length > 0
      ? payload.rows.map((row) =>
          `- ${row.label} | key=${row.key} | candidate=${row.candidate ?? 'n/a'} | policyBlocked=${row.blockedByPolicy ? 'yes' : 'no'} | reason=${row.reason}`
        )
      : ['- 없음']),
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ].filter(Boolean).join('\n');
}

function buildRuntimeEscalateFallback(payload = {}) {
  const decision = payload.decision || {};
  const metrics = decision.metrics || {};
  if (decision.status === 'escalate_blocked') {
    return `allow 레일로 못 푸는 policy-blocked 후보가 ${metrics.blockedByPolicy || 0}건 있어 운영 승인 경로로 분리하는 편이 좋습니다.`;
  }
  if (decision.status === 'escalate_ready') {
    return `승인 검토가 필요한 escalate 후보가 ${metrics.approvalNeeded || 0}건 준비돼 있어 운영 판단 문맥과 함께 올리면 됩니다.`;
  }
  return '즉시 올릴 escalate 후보는 아직 없어 allow 후보와 autotune readiness 누적을 계속 보면 됩니다.';
}

export async function buildRuntimeEscalateCandidatesReport({ days = 14, json = false } = {}) {
  const [autotune, relief] = await Promise.all([
    buildRuntimeAutotuneReadinessReport({ days, limit: 20, json: true }).catch(() => null),
    buildRuntimeMinOrderReliefReport({ days, json: true }).catch(() => null),
  ]);
  const rows = buildCandidates({ autotune, relief });
  const decision = buildDecision(rows, autotune);
  const payload = {
    ok: true,
    days,
    rows,
    autotune,
    relief,
    decision,
  };
  payload.aiSummary = await buildInvestmentCliInsight({
    bot: 'runtime-escalate-candidates-report',
    requestType: 'runtime-escalate-candidates-report',
    title: '투자 runtime escalate candidates 리포트 요약',
    data: {
      days,
      decision,
      rows,
      autotuneDecision: autotune?.decision,
      reliefDecision: relief?.decision,
    },
    fallback: buildRuntimeEscalateFallback(payload),
  });
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeEscalateCandidatesReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-escalate-candidates-report 오류:',
  });
}
