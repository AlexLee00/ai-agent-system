#!/usr/bin/env node
// @ts-nocheck

import { getInvestmentRuntimeConfig } from '../shared/runtime-config.ts';
import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildRuntimeRiskApprovalReport } from './runtime-risk-approval-report.ts';
import { buildRuntimeRiskApprovalHistory } from './runtime-risk-approval-history.ts';
import { buildRuntimeExecutionRiskGuardReport } from './runtime-execution-risk-guard-report.ts';
import { buildRuntimeExecutionRiskGuardHistory } from './runtime-execution-risk-guard-history.ts';

// Risk approval preview persistence was added after historical BUY executions had already accumulated.
// Treat older executions as pre-cutover baseline so the monitor only flags fresh telemetry gaps.
export const RISK_APPROVAL_PREVIEW_PERSISTENCE_CUTOVER_AT = '2026-04-23T12:35:00.000Z';

function parseArgs(argv = process.argv.slice(2)) {
  const daysArg = argv.find((arg) => arg.startsWith('--days='));
  return {
    days: Math.max(1, Number(daysArg?.split('=').slice(1).join('=') || 30)),
    json: argv.includes('--json'),
  };
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function rate(part, total) {
  const p = safeNumber(part);
  const t = safeNumber(total);
  if (t <= 0) return 0;
  return p / t;
}

function pct(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'n/a';
  return `${(n * 100).toFixed(digits)}%`;
}

function getCurrentModeConfig() {
  const riskApprovalChain = getInvestmentRuntimeConfig()?.nemesis?.riskApprovalChain || {};
  return {
    mode: String(riskApprovalChain.mode || 'shadow'),
    assist: {
      applyAmountReduction: riskApprovalChain.assist?.applyAmountReduction !== false,
      maxReductionPct: safeNumber(riskApprovalChain.assist?.maxReductionPct, 0.35),
    },
    enforce: {
      rejectOnPreviewReject: riskApprovalChain.enforce?.rejectOnPreviewReject !== false,
      applyAmountReduction: riskApprovalChain.enforce?.applyAmountReduction !== false,
    },
  };
}

export function buildRiskApprovalModeDryRun(riskApproval = {}, modeConfig = {}) {
  const summary = riskApproval.summary || {};
  const amount = summary.amount || {};
  const total = safeNumber(summary.total);
  const previewRejects = safeNumber(summary.previewRejects);
  const reductions = safeNumber(amount.previewAmountReductions);
  const previewDelta = safeNumber(amount.previewVsApprovedDelta);
  return {
    shadow: {
      applied: 0,
      rejected: 0,
      amountDelta: 0,
      note: 'preview만 기록하고 기존 네메시스 승인 결과는 바꾸지 않습니다.',
    },
    assist: {
      applied: modeConfig.assist?.applyAmountReduction ? reductions : 0,
      rejected: 0,
      amountDelta: modeConfig.assist?.applyAmountReduction ? previewDelta : 0,
      maxReductionPct: modeConfig.assist?.maxReductionPct,
      note: 'preview 거절은 차단하지 않고, 승인 금액 감산만 제한적으로 반영합니다.',
    },
    enforce: {
      applied: modeConfig.enforce?.applyAmountReduction ? reductions : 0,
      rejected: modeConfig.enforce?.rejectOnPreviewReject ? previewRejects : 0,
      amountDelta: modeConfig.enforce?.applyAmountReduction ? previewDelta : 0,
      note: 'preview 거절과 금액 감산을 실제 네메시스 승인 결과에 반영합니다.',
    },
    sample: {
      total,
      reductions,
      previewRejects,
      approvedAmount: safeNumber(amount.approved),
      previewFinalAmount: safeNumber(amount.previewFinal),
      previewVsApprovedDelta: previewDelta,
    },
  };
}

export async function loadRiskApprovalSampleContext({ days = 30 } = {}) {
  await db.initSchema();
  const sinceMs = Date.now() - Math.max(1, Number(days || 30)) * 24 * 60 * 60 * 1000;
  const cutoverAt = RISK_APPROVAL_PREVIEW_PERSISTENCE_CUTOVER_AT;
  const rationaleRows = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE strategy_config->'risk_approval_preview' IS NOT NULL)::int AS with_preview,
      COUNT(*) FILTER (WHERE strategy_config->'risk_approval_preview' IS NULL)::int AS without_preview,
      COUNT(*) FILTER (
        WHERE created_at >= EXTRACT(EPOCH FROM $2::timestamptz) * 1000
          AND strategy_config->'risk_approval_preview' IS NOT NULL
      )::int AS with_preview_after_cutover
    FROM investment.trade_rationale
    WHERE created_at >= $1
  `, [sinceMs, cutoverAt]).catch(() => [{
    total: 0,
    with_preview: 0,
    without_preview: 0,
    with_preview_after_cutover: 0,
  }]);
  const signalRows = await db.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE action = 'BUY')::int AS buy_total,
      COUNT(*) FILTER (WHERE action = 'BUY' AND status = 'executed')::int AS executed_buy,
      COUNT(*) FILTER (
        WHERE action = 'BUY'
          AND status = 'executed'
          AND created_at >= $2::timestamptz
      )::int AS executed_buy_after_cutover,
      COUNT(*) FILTER (WHERE action = 'BUY' AND status = 'blocked')::int AS blocked_buy,
      COUNT(*) FILTER (WHERE action = 'BUY' AND status = 'failed')::int AS failed_buy,
      MAX(created_at) FILTER (WHERE action = 'BUY' AND status = 'executed') AS latest_executed_buy_at,
      MAX(created_at) FILTER (
        WHERE action = 'BUY'
          AND status = 'executed'
          AND created_at >= $2::timestamptz
      ) AS latest_executed_buy_after_cutover_at
    FROM investment.signals
    WHERE created_at >= now() - ($1::int * interval '1 day')
  `, [Math.max(1, Number(days || 30)), cutoverAt]).catch(() => [{
    total: 0,
    buy_total: 0,
    executed_buy: 0,
    executed_buy_after_cutover: 0,
    blocked_buy: 0,
    failed_buy: 0,
    latest_executed_buy_at: null,
    latest_executed_buy_after_cutover_at: null,
  }]);

  const rationale = rationaleRows[0] || {};
  const signals = signalRows[0] || {};
  return {
    days: Number(days),
    previewPersistenceCutoverAt: cutoverAt,
    rationaleTotal: safeNumber(rationale.total),
    rationaleWithPreview: safeNumber(rationale.with_preview),
    rationaleWithPreviewAfterCutover: safeNumber(rationale.with_preview_after_cutover),
    rationaleWithoutPreview: safeNumber(rationale.without_preview),
    signalTotal: safeNumber(signals.total),
    buySignals: safeNumber(signals.buy_total),
    executedBuySignals: safeNumber(signals.executed_buy),
    executedBuySignalsAfterCutover: safeNumber(signals.executed_buy_after_cutover),
    blockedBuySignals: safeNumber(signals.blocked_buy),
    failedBuySignals: safeNumber(signals.failed_buy),
    latestExecutedBuyAt: signals.latest_executed_buy_at || null,
    latestExecutedBuyAfterCutoverAt: signals.latest_executed_buy_after_cutover_at || null,
  };
}

export function buildRiskApprovalReadinessDecision({ riskApproval, executionGuard, modeConfig, sampleContext = null }) {
  const summary = riskApproval.summary || {};
  const amount = summary.amount || {};
  const outcome = summary.outcome?.total || {};
  const outcomeMode = summary.outcome?.byMode?.[0] || null;
  const guardSummary = executionGuard.summary || {};
  const total = safeNumber(summary.total);
  const previewRejects = safeNumber(summary.previewRejects);
  const divergence = safeNumber(summary.legacyApprovedPreviewRejected);
  const outcomeClosed = safeNumber(outcome.closed);
  const outcomePnlNet = safeNumber(outcome.pnlNet);
  const outcomeAvgPnlPercent = outcome.avgPnlPercent == null ? null : Number(outcome.avgPnlPercent);
  const outcomeModeAvgPnlPercent = outcomeMode?.avgPnlPercent == null ? null : Number(outcomeMode.avgPnlPercent);
  const outcomeWeak =
    outcomeClosed >= 3 &&
    (
      outcomePnlNet < 0 ||
      Number(outcomeAvgPnlPercent ?? 0) < 0 ||
      Number(outcomeModeAvgPnlPercent ?? 0) < 0
    );
  const stale = safeNumber(guardSummary.staleCount);
  const bypass = safeNumber(guardSummary.bypassCount);
  const rejectionRate = rate(previewRejects, total);
  const divergenceRate = rate(divergence, total);
  const reductionRate = rate(amount.previewAmountReductions, total);
  const reasons = [
    `mode ${modeConfig.mode}`,
    `preview ${total}`,
    `preview reject ${previewRejects} (${pct(rejectionRate)})`,
    `divergence ${divergence} (${pct(divergenceRate)})`,
    `execution stale ${stale}`,
    `execution bypass ${bypass}`,
    `amount reduction candidates ${safeNumber(amount.previewAmountReductions)} (${pct(reductionRate)})`,
    `outcome closed ${outcomeClosed}, pnl ${outcomePnlNet}, avg ${outcomeAvgPnlPercent ?? 'n/a'}%`,
  ];
  if (sampleContext) {
    reasons.push(`sample context rationale ${sampleContext.rationaleTotal || 0} / preview ${sampleContext.rationaleWithPreview || 0} / executed BUY signals ${sampleContext.executedBuySignals || 0}`);
    reasons.push(`preview cutover ${sampleContext.previewPersistenceCutoverAt || RISK_APPROVAL_PREVIEW_PERSISTENCE_CUTOVER_AT} / executed BUY after cutover ${sampleContext.executedBuySignalsAfterCutover || 0} / preview after cutover ${sampleContext.rationaleWithPreviewAfterCutover || 0}`);
  }
  const blockers = [];
  const actionItems = [];
  let status = 'risk_approval_readiness_collect_samples';
  let targetMode = modeConfig.mode;
  let headline = '리스크 승인 체인 전환을 판단하기에는 preview 표본이 아직 부족합니다.';

  if (total < 20) blockers.push('preview 표본 20건 미만');
  if (divergence > 0) blockers.push('기존 승인/preview 거절 divergence 존재');
  if (stale > 0) blockers.push('실행 직전 stale approval 차단 존재');
  if (bypass > 0) blockers.push('실행 직전 네메시스 승인 누락 차단 존재');
  if (rejectionRate > 0.3) blockers.push('preview reject 비율 30% 초과');
  if (outcomeWeak) blockers.push('리스크 승인 사후 성과 음수');

  const telemetryGap =
    total === 0
    && sampleContext
    && safeNumber(sampleContext.executedBuySignalsAfterCutover) > 0
    && safeNumber(sampleContext.rationaleWithPreviewAfterCutover) === 0;

  const waitingPostCutoverSample =
    total === 0
    && sampleContext
    && safeNumber(sampleContext.executedBuySignals) > 0
    && safeNumber(sampleContext.executedBuySignalsAfterCutover) === 0
    && safeNumber(sampleContext.rationaleWithPreview) === 0;

  if (telemetryGap) {
    status = 'risk_approval_readiness_telemetry_gap';
    headline = 'cutover 이후 executed BUY 신호는 있지만 risk approval preview 텔레메트리가 trade_rationale에 쌓이지 않습니다.';
    blockers.length = 0;
    blockers.push('risk approval preview telemetry gap');
    actionItems.push('네메시스 승인 경로의 persist 플래그와 trade_rationale insert 경로가 live 실행에서 호출되는지 점검합니다.');
    actionItems.push('신규 BUY 승인 1건부터 risk_approval_preview가 strategy_config에 저장되는지 확인합니다.');
  } else if (waitingPostCutoverSample) {
    status = 'risk_approval_readiness_waiting_post_cutover_sample';
    headline = 'risk approval preview 저장 패치 이후 신규 executed BUY 표본을 기다리는 상태입니다.';
    blockers.length = 0;
    actionItems.push('다음 신규 BUY 승인/실행 1건에서 trade_rationale.strategy_config.risk_approval_preview 저장 여부를 확인합니다.');
    actionItems.push('cutover 이전 실행 113건은 과거 표본으로 분리하고, 신규 표본부터 readiness를 판단합니다.');
  } else if (blockers.length > 0) {
    status = divergence > 0 || stale > 0 || bypass > 0 || outcomeWeak
      ? 'risk_approval_readiness_blocked'
      : 'risk_approval_readiness_collect_samples';
    headline = blockers.join(' / ');
    actionItems.push('shadow mode에서 표본을 계속 누적하고 blocker가 사라지는지 먼저 확인합니다.');
    if (divergence > 0) actionItems.push('divergence sample의 regime/consensus/feedback 임계값을 검토합니다.');
    if (stale > 0 || bypass > 0) actionItems.push('승인→실행 큐 연결과 승인 메타 전파 경로를 우선 점검합니다.');
    if (outcomeWeak) actionItems.push('runtime-suggest의 risk approval outcome 제안을 확인해 assist 감산율과 모델별 임계값을 재검토합니다.');
  } else if (modeConfig.mode === 'shadow') {
    status = 'risk_approval_readiness_assist_ready';
    targetMode = 'assist';
    headline = 'shadow preview가 큰 충돌 없이 누적되어 assist 전환 후보입니다.';
    actionItems.push('마스터 승인 후 mode=assist로 전환하면 preview 감산을 제한적으로 실제 승인 금액에 반영할 수 있습니다.');
    actionItems.push('enforce 전환은 assist 적용 표본을 별도로 확인한 뒤 판단합니다.');
  } else if (modeConfig.mode === 'assist') {
    if (total >= 50) {
      status = 'risk_approval_readiness_enforce_candidate';
      targetMode = 'enforce';
      headline = 'assist 운용 표본이 충분하면 enforce 후보로 검토할 수 있습니다.';
      actionItems.push('preview reject가 실제로 차단되어도 되는 케이스인지 샘플 리뷰 후 enforce 전환을 승인합니다.');
    } else {
      status = 'risk_approval_readiness_assist_observe';
      headline = 'assist 운용 중이며 enforce 전환 전 표본 누적이 더 필요합니다.';
      actionItems.push('assist 적용 표본 50건 이상에서 divergence와 실행 가드 차단이 없는지 확인합니다.');
    }
  } else if (modeConfig.mode === 'enforce') {
    status = 'risk_approval_readiness_enforced';
    headline = '리스크 승인 체인이 enforce 모드로 실행 결과에 직접 반영 중입니다.';
    actionItems.push('preview reject/amount reduction이 성과와 체결률을 해치지 않는지 지속 점검합니다.');
  }

  return {
    status,
    headline,
    currentMode: modeConfig.mode,
    targetMode,
    blockers,
    reasons,
    actionItems,
    metrics: {
      total,
      previewRejects,
      rejectionRate,
      divergence,
      divergenceRate,
      executionStale: stale,
      executionBypass: bypass,
      amountReductionCandidates: safeNumber(amount.previewAmountReductions),
      reductionRate,
      outcomeClosed,
      outcomePnlNet,
      outcomeAvgPnlPercent,
      outcomeMode: outcomeMode ? {
        mode: outcomeMode.mode || null,
        closed: safeNumber(outcomeMode.closed),
        pnlNet: safeNumber(outcomeMode.pnlNet),
        avgPnlPercent: outcomeModeAvgPnlPercent,
      } : null,
      sampleContext,
    },
  };
}

function renderText(payload) {
  return [
    '🛡️ Risk Approval Mode Readiness',
    `days: ${payload.days}`,
    `status: ${payload.decision.status}`,
    `headline: ${payload.decision.headline}`,
    `current mode: ${payload.decision.currentMode}`,
    `target mode: ${payload.decision.targetMode}`,
    '',
    '근거:',
    ...payload.decision.reasons.map((reason) => `- ${reason}`),
    payload.decision.metrics?.outcomeMode
      ? `- outcome mode ${payload.decision.metrics.outcomeMode.mode || 'n/a'}: closed ${payload.decision.metrics.outcomeMode.closed}, pnl ${payload.decision.metrics.outcomeMode.pnlNet}, avg ${payload.decision.metrics.outcomeMode.avgPnlPercent ?? 'n/a'}%`
      : null,
    '',
    'mode dry-run:',
    `- shadow: applied ${payload.modeDryRun.shadow.applied}, rejected ${payload.modeDryRun.shadow.rejected}, amount delta ${payload.modeDryRun.shadow.amountDelta}`,
    `- assist: applied ${payload.modeDryRun.assist.applied}, rejected ${payload.modeDryRun.assist.rejected}, amount delta ${payload.modeDryRun.assist.amountDelta}`,
    `- enforce: applied ${payload.modeDryRun.enforce.applied}, rejected ${payload.modeDryRun.enforce.rejected}, amount delta ${payload.modeDryRun.enforce.amountDelta}`,
    '',
    '권장 조치:',
    ...payload.decision.actionItems.map((item) => `- ${item}`),
  ].filter(Boolean).join('\n');
}

export async function buildRuntimeRiskApprovalReadiness({ days = 30, json = false } = {}) {
  const [riskApproval, riskApprovalTrend, executionGuard, executionGuardTrend, sampleContext] = await Promise.all([
    buildRuntimeRiskApprovalReport({ days, json: true }),
    buildRuntimeRiskApprovalHistory({ days, json: true, write: false }),
    buildRuntimeExecutionRiskGuardReport({ days, json: true }),
    buildRuntimeExecutionRiskGuardHistory({ days, json: true, write: false }),
    loadRiskApprovalSampleContext({ days }),
  ]);
  const modeConfig = getCurrentModeConfig();
  const modeDryRun = buildRiskApprovalModeDryRun(riskApproval, modeConfig);
  const decision = buildRiskApprovalReadinessDecision({ riskApproval, executionGuard, modeConfig, sampleContext });
  const payload = {
    ok: true,
    days: Number(days),
    generatedAt: new Date().toISOString(),
    modeConfig,
    decision,
    modeDryRun,
    riskApproval: {
      status: riskApproval.decision?.status || 'unknown',
      summary: riskApproval.summary || {},
      trend: riskApprovalTrend.delta || {},
    },
    sampleContext,
    executionGuard: {
      status: executionGuard.decision?.status || 'unknown',
      summary: executionGuard.summary || {},
      trend: executionGuardTrend.delta || {},
    },
  };
  if (json) return payload;
  return renderText(payload);
}

async function main() {
  const args = parseArgs();
  const result = await buildRuntimeRiskApprovalReadiness(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(result);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-risk-approval-readiness 오류:',
  });
}
