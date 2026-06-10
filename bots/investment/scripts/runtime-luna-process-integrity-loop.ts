#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaSourceHealthAudit } from '../shared/luna-source-health-audit.ts';
import { buildTradeDataAnalysisReport } from '../shared/trade-data-analysis-report.ts';
import { isExpectedPolicyBlockCode } from '../shared/trade-data-hygiene.ts';
import { buildLunaLiveFireFinalGate } from './luna-live-fire-final-gate.ts';
import { runLunaOperationalActionBoard } from './runtime-luna-operational-action-board.ts';
import { runAgentMessageBusHygiene } from './runtime-agent-message-bus-hygiene.ts';

function hasFlag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function topItems(items = [], limit = 5) {
  return [...(items || [])]
    .filter(Boolean)
    .sort((a, b) => num(b.count ?? b.losses ?? b.closed) - num(a.count ?? a.losses ?? a.closed))
    .slice(0, limit);
}

function unique(items = []) {
  return [...new Set((items || []).filter(Boolean))];
}

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error) {
  return error?.message || String(error || 'unknown_error');
}

function isTransientProcessIntegrityError(error) {
  const text = errorMessage(error).toLowerCase();
  return text.includes('timeout')
    || text.includes('trying to connect')
    || text.includes('connection terminated')
    || text.includes('econnreset')
    || text.includes('etimedout');
}

function isAgentBusQueryFailedBlocker(item = '') {
  return String(item || '') === 'agent_message_bus_hygiene:query_failed';
}

export function normalizeActionBoardAgentBusQueryFailure(actionBoard = {}, busHygieneRetry = null) {
  const hardBlockers = actionBoard.hardBlockers || [];
  if (!hardBlockers.some(isAgentBusQueryFailedBlocker)) return actionBoard;
  const retryCleared = busHygieneRetry && busHygieneRetry.ok !== false && !String(busHygieneRetry.status || '').includes('failed');
  if (!retryCleared) {
    return {
      ...actionBoard,
      operationalWarnings: unique([
        ...(actionBoard.operationalWarnings || []),
        'agent_message_bus_hygiene_query_failed_retry_failed',
      ]),
      agentBusHygieneRetry: busHygieneRetry || null,
    };
  }
  const remainingHardBlockers = hardBlockers.filter((item) => !isAgentBusQueryFailedBlocker(item));
  const sourceStatus = remainingHardBlockers.length === 0 && String(actionBoard.sourceStatus || '').includes('blocked')
    ? 'operational_clear_after_retry'
    : actionBoard.sourceStatus;
  return {
    ...actionBoard,
    sourceStatus,
    originalSourceStatus: actionBoard.sourceStatus || null,
    hardBlockers: remainingHardBlockers,
    operationalWarnings: unique([
      ...(actionBoard.operationalWarnings || []),
      'agent_message_bus_hygiene_query_failed_retry_clear',
    ]),
    agentBusHygieneRetry: {
      status: busHygieneRetry.status,
      staleCount: Number(busHygieneRetry.before?.staleCount || 0),
      reviewRequired: Number(busHygieneRetry.reviewReport?.reviewRequired || 0),
      safeExpire: Number(busHygieneRetry.reviewReport?.safeExpire || 0),
    },
  };
}

function blockedReasonOf(item = {}) {
  return String(item.reason || item.block_code || item.code || item.id || 'unknown').trim() || 'unknown';
}

const PREFILTER_REMEDIATION_BY_REASON = {
  sec015_overseas_stale_approval: {
    stage: 'approval_freshness_preflight',
    owner: 'risk_approval_execution',
    action: '실행 직전 SEC015 승인 freshness를 검사하고 stale이면 주문 단계 대신 refresh/defer 큐로 이동',
    command: 'npm --prefix bots/investment run -s runtime:execution-risk-guard -- --json --days=14',
  },
  sec015_stale_approval: {
    stage: 'approval_freshness_preflight',
    owner: 'risk_approval_execution',
    action: '승인 생성 시각과 실행 시각 간 TTL을 entry preflight에서 검증해 stale 실행 시도를 차단',
    command: 'npm --prefix bots/investment run -s runtime:execution-risk-guard -- --json --days=14',
  },
  capital_guard_rejected: {
    stage: 'capital_preflight',
    owner: 'candidate_sizing_execution',
    action: '가용 슬롯/자본 backpressure를 후보 점수와 sizing 전 단계에 반영해 실행단 capital reject를 줄임',
    command: 'npm --prefix bots/investment run -s runtime:binance-failure-pressure -- --json --days=14',
  },
  capital_backpressure: {
    stage: 'capital_preflight',
    owner: 'candidate_sizing_execution',
    action: '자본 압박 상태에서는 신규 후보를 observation/probe로 낮추고 실행 후보 생성을 제한',
    command: 'npm --prefix bots/investment run -s runtime:binance-failure-pressure -- --json --days=14',
  },
  live_position_reentry_blocked: {
    stage: 'reentry_prefilter',
    owner: 'position_runtime_candidate_gate',
    action: '동일 심볼 보유/최근 매수 상태를 후보 생성 단계에서 반영해 중복 진입 신호 생성을 억제',
    command: 'npm --prefix bots/investment run -s runtime:binance-failure-pressure -- --json --days=14',
  },
  live_position_reentry_blocked_recent_buy_signal: {
    stage: 'reentry_prefilter',
    owner: 'position_runtime_candidate_gate',
    action: '최근 매수 신호 쿨다운을 candidate/promotion trigger에 주입해 반복 재진입 차단을 상류화',
    command: 'npm --prefix bots/investment run -s runtime:binance-failure-pressure -- --json --days=14',
  },
  position_sizing_rejected: {
    stage: 'sizing_preflight',
    owner: 'execution_sizing',
    action: '최소 주문금액/최대 위험/수량 정규화 실패를 주문 직전이 아니라 sizing 산출 단계에서 dry rejection으로 기록',
    command: 'npm --prefix bots/investment run -s runtime:position-runtime-autopilot-bottleneck -- --json',
  },
  safety_gate_blocked: {
    stage: 'safety_preflight',
    owner: 'safety_gate',
    action: 'safety gate 결과를 execution request 생성 전에 첨부해 주문 단계 진입 전 차단 사유를 확정',
    command: 'npm --prefix bots/investment run -s runtime:luna-operational-action-board -- --json',
  },
  journal_open_entry_missing_for_sell: {
    stage: 'journal_integrity_preflight',
    owner: 'journal_reconcile',
    action: 'SELL 신호 생성 전 open journal 존재 여부를 검증하고 누락 시 manual reconcile evidence로 분리',
    command: 'npm --prefix bots/investment run -s runtime:luna-operational-action-board -- --json',
  },
  trade_data_entry_guard_rejected: {
    stage: 'trade_data_entry_guard',
    owner: 'trade_data_quality',
    action: '학습 데이터 기반 entry guard reject를 후보 점수 감점과 observation 전환에 반영',
    command: 'npm --prefix bots/investment run -s runtime:luna-trade-data-analysis-report -- --json',
  },
};

const STRATEGY_GUARD_COVERAGE = {
  promotion_ready_shadow: [
    'promotion_ready_shadow_current_epoch_probe_only',
    'promotion_ready_shadow_without_confirmation',
    'promotion_ready_shadow_confirmation_quality_thin',
  ],
  mean_reversion: [
    'crypto_mean_reversion_current_epoch_probe_only',
    'crypto_mean_reversion_without_reversal_evidence',
    'crypto_ranging_without_reversal_confirmation',
  ],
  trend_following: [
    'crypto_trend_following_current_epoch_probe_only',
    'crypto_trend_following_without_confirmation',
    'crypto_trend_following_confirmation_quality_thin',
  ],
  short_term_scalping: [
    'crypto_short_term_scalping_early_exit_loss_pressure',
    'crypto_short_term_scalping_ranging_without_confirmation',
    'crypto_ranging_without_reversal_confirmation',
  ],
  defensive_rotation: [
    'crypto_defensive_rotation_loss_epoch_probe',
    'crypto_defensive_rotation_without_live_evidence',
    'crypto_defensive_rotation_confirmation_quality_thin',
    'domestic_defensive_rotation_probe_only',
  ],
};

function buildPolicyBlockCoverage(blockedReasons = []) {
  const rows = (blockedReasons || []).map((row) => ({
    reason: blockedReasonOf(row),
    count: num(row.count, 0),
    expectedPolicyBlock: isExpectedPolicyBlockCode(blockedReasonOf(row)),
    remediationStage: (PREFILTER_REMEDIATION_BY_REASON[blockedReasonOf(row)] || {}).stage || 'reason_specific_review',
  }));
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const expected = rows.filter((row) => row.expectedPolicyBlock).reduce((sum, row) => sum + row.count, 0);
  return {
    rows,
    total,
    expected,
    unexpected: Math.max(0, total - expected),
    allExpectedPolicyBlocks: rows.length > 0 && rows.every((row) => row.expectedPolicyBlock),
  };
}

function trendPolicyCoverage(trend = {}) {
  return {
    last24h: buildPolicyBlockCoverage(trend.last24h?.blockedReasons || []),
    last2h: buildPolicyBlockCoverage(trend.last2h?.blockedReasons || []),
    totals: {
      last24h: num(trend.last24h?.total, 0),
      last2h: num(trend.last2h?.total, 0),
      unexpected24h: num(trend.last24h?.unexpected, 0),
      unexpected2h: num(trend.last2h?.unexpected, 0),
    },
  };
}

function buildStrategyGuardCoverage(strategies = []) {
  return (strategies || []).map((item) => {
    const key = String(item.name || item.strategy || '').toLowerCase();
    return {
      strategy: key || 'unknown',
      covered: Array.isArray(STRATEGY_GUARD_COVERAGE[key]) && STRATEGY_GUARD_COVERAGE[key].length > 0,
      guardCodes: STRATEGY_GUARD_COVERAGE[key] || [],
    };
  });
}

function buildEarlyExitGuardCoverage(samples = []) {
  return (samples || []).map((item) => {
    const key = String(item.strategyFamily || item.originalStrategyFamily || '').toLowerCase();
    return {
      symbol: item.symbol || null,
      strategy: key || 'unknown',
      loss: num(item.pnlPercent, 0) < 0,
      covered: Array.isArray(STRATEGY_GUARD_COVERAGE[key]) && STRATEGY_GUARD_COVERAGE[key].length > 0,
      guardCodes: STRATEGY_GUARD_COVERAGE[key] || [],
    };
  });
}

function buildPrefilterRemediationPlan(blockedReasons = [], limit = 6) {
  return topItems(blockedReasons, limit).map((item) => {
    const reason = blockedReasonOf(item);
    const policy = PREFILTER_REMEDIATION_BY_REASON[reason] || {
      stage: 'reason_specific_review',
      owner: 'process_integrity',
      action: '반복 blocked reason의 발생 위치를 확인하고 실행 단계보다 앞선 후보/승인/sizing 단계로 이동 가능한지 검토',
      command: 'npm --prefix bots/investment run -s runtime:luna-trade-data-analysis-report -- --json',
    };
    return {
      reason,
      count: num(item.count, 0),
      stage: policy.stage,
      owner: policy.owner,
      action: policy.action,
      command: policy.command,
    };
  });
}

function remediationNextActions(plan = []) {
  return unique(plan.map((item) => `${item.reason}: ${item.action}`));
}

function remediationCommands(plan = []) {
  return unique(plan.map((item) => item.command));
}

function collectHardBlockers({ actionBoard = {}, sourceHealth = {}, finalGate = {}, tradeData = {} } = {}) {
  const blockers = [];
  for (const item of actionBoard.hardBlockers || []) blockers.push(`operational:${item}`);
  for (const item of finalGate.blockers || []) blockers.push(`live_fire:${item}`);
  for (const item of sourceHealth.blockers || []) blockers.push(`source_health:${item}`);
  for (const item of tradeData.hygiene?.findings || []) {
    if (String(item.severity || '').toUpperCase() !== 'P0') continue;
    const stableId = item.id || item.code || item.reason || 'finding';
    blockers.push(`trade_data_hygiene:${stableId}`);
  }
  if (actionBoard.manualReconcile?.count > 0) blockers.push(`manual_reconcile_tasks:${actionBoard.manualReconcile.count}`);
  if (actionBoard.exchangeLookupRetry?.count > 0) blockers.push(`exchange_lookup_retry_tasks:${actionBoard.exchangeLookupRetry.count}`);
  if (actionBoard.ackQueue?.count > 0) blockers.push(`ack_queue_pending:${actionBoard.ackQueue.count}`);
  return [...new Set(blockers)];
}

function collectWatchItems({ tradeData = {}, sourceHealth = {} } = {}) {
  const watch = [];
  const advisoryHygieneFindings = (tradeData.hygiene?.findings || [])
    .filter((item) => String(item.severity || '').toUpperCase() !== 'P0');
  if (advisoryHygieneFindings.length > 0) {
    watch.push({
      id: 'trade_data_hygiene_advisory_backlog',
      severity: 'advisory',
      summary: 'P1 이하 trade-data hygiene 항목은 학습 품질 백로그로 추적하되 live-fire hard blocker로 승격하지 않습니다.',
      evidence: advisoryHygieneFindings.map((item) => ({
        id: item.id || item.code || item.reason || 'finding',
        severity: item.severity || 'unknown',
        count: item.count ?? null,
        reason: item.reason || null,
      })),
      nextAction: 'realized PnL/posttrade 백필을 운영 백로그로 처리하고 P0 정합성 이슈가 발생할 때만 live-fire 차단으로 승격',
    });
  }
  const blockedReasons = topItems(tradeData.signals?.blockedReasons || [], 6);
  const remediationPlan = buildPrefilterRemediationPlan(tradeData.signals?.blockedReasons || [], 6);
  const policyCoverage = buildPolicyBlockCoverage(blockedReasons);
  const recentBlockTrend = tradeData.signals?.blockedReasonTrend || null;
  const recentPolicyCoverage = recentBlockTrend ? trendPolicyCoverage(recentBlockTrend) : null;
  const rawExecutionRate = num(tradeData.signals?.executionRate, 1);
  const executionRate = tradeData.signals?.policyAdjustedExecutionRate == null
    ? rawExecutionRate
    : num(tradeData.signals?.policyAdjustedExecutionRate, rawExecutionRate);
  const noVeryRecentBlocks = recentPolicyCoverage && recentPolicyCoverage.totals.last2h === 0;
  const onlyExpectedRecentBlocks = recentPolicyCoverage
    && recentPolicyCoverage.totals.unexpected24h === 0
    && recentPolicyCoverage.totals.unexpected2h === 0;
  const recentPressureCooling = Boolean(noVeryRecentBlocks && onlyExpectedRecentBlocks);
  const policyBlocksAbsorbed = policyCoverage.allExpectedPolicyBlocks
    && (executionRate >= 0.9 || recentPressureCooling);
  if (blockedReasons.length > 0) {
    watch.push({
      id: 'signal_block_reason_prefilter_review',
      severity: policyBlocksAbsorbed ? 'advisory' : 'watch',
      summary: policyBlocksAbsorbed
        ? 'blocked 신호는 현재 expected policy block으로 분류되어 실행 후보 품질 지표에서 흡수됩니다.'
        : 'blocked 신호가 실행 단계까지 내려오므로 prefilter/후보 단계에서 더 일찍 차단할 여지가 있습니다.',
      evidence: {
        blockedReasons,
        remediationPlan,
        policyCoverage,
        recentPolicyCoverage,
        executionRate,
        rawExecutionRate,
      },
      nextAction: policyBlocksAbsorbed
        ? 'expected policy block 추세만 관찰하고 unexpected block이 생기면 prefilter 소유 단계로 재분류'
        : '상위 blocked reason을 reason별 preflight 소유 단계로 라우팅하고 반복 차단을 실행 전 관찰/후보 단계에서 흡수',
    });
  }
  if (executionRate < 0.6) {
    watch.push({
      id: 'execution_rate_below_watch_floor',
      severity: 'watch',
      summary: '운영 에포크 policy-adjusted executionRate가 60% 미만입니다.',
      evidence: {
        executionRate,
        rawExecutionRate,
        policyBlockedSignals: tradeData.signals?.policyBlockedSignals || 0,
        executionCandidateSignals: tradeData.signals?.executionCandidateSignals || tradeData.signals?.total || 0,
        totalSignals: tradeData.signals?.total || 0,
      },
      nextAction: '반복 blocked reason을 entry 전 prefilter로 이동하고 candidate scoring을 보수화',
    });
  }
  const weakStrategies = (tradeData.journal?.strategyFamily?.buckets || [])
    .filter((bucket) => num(bucket.closed) >= 3 && num(bucket.avgPnlPercent) < 0)
    .sort((a, b) => num(a.avgPnlPercent) - num(b.avgPnlPercent))
    .slice(0, 5);
  if (weakStrategies.length > 0) {
    const strategyGuardCoverage = buildStrategyGuardCoverage(weakStrategies);
    const uncoveredStrategies = strategyGuardCoverage.filter((item) => item.covered !== true);
    watch.push({
      id: 'weak_strategy_family_review',
      severity: uncoveredStrategies.length === 0 ? 'advisory' : 'watch',
      summary: uncoveredStrategies.length === 0
        ? '평균 손실 전략군은 모두 현재 entry guard로 커버되며 가드 이후 성과 재관찰 대상으로 유지합니다.'
        : '충분한 폐쇄 샘플이 있는 전략군 중 아직 entry guard 커버가 불명확한 평균 손실 전략이 있습니다.',
      evidence: weakStrategies.map((item) => ({
        strategy: item.name,
        closed: item.closed,
        avgPnlPercent: item.avgPnlPercent,
        winRate: item.winRate,
      })),
      guardCoverage: strategyGuardCoverage,
      uncoveredStrategies,
      nextAction: uncoveredStrategies.length === 0
        ? 'entry guard 커버 이후 closed sample만 별도 비교해 bias 복구 여부 판단'
        : '평균 손실 전략군은 신규 진입 bias를 낮추고 observation/probe 또는 추가 confirmation으로 강등',
    });
  }
  const earlyExit = tradeData.journal?.earlyExit || {};
  if (earlyExit.underOneHour && num(earlyExit.losses) > 0) {
    const sampleGuardCoverage = buildEarlyExitGuardCoverage((earlyExit.samples || []).slice(0, 5));
    const uncoveredLossSamples = sampleGuardCoverage.filter((item) => item.loss && item.covered !== true);
    watch.push({
      id: 'early_exit_loss_cluster_review',
      severity: uncoveredLossSamples.length === 0 ? 'advisory' : 'watch',
      summary: uncoveredLossSamples.length === 0
        ? '1시간 미만 조기 종료 손실 클러스터는 현재 entry guard로 커버되며 신규 샘플 추적 대상으로 유지합니다.'
        : '1시간 미만 조기 종료 손실 클러스터 중 아직 entry guard 커버가 불명확한 샘플이 있습니다.',
      evidence: {
        total: earlyExit.total || 0,
        losses: earlyExit.losses || 0,
        samples: (earlyExit.samples || []).slice(0, 5),
        guardCoverage: sampleGuardCoverage,
        uncoveredLossSamples,
      },
      nextAction: uncoveredLossSamples.length === 0
        ? 'entry guard 커버 이후 발생한 신규 조기손실 샘플만 별도 추적'
        : '하드스탑 외 조기 청산은 최소 보유/재확인 게이트를 유지하고 손실 클러스터 원인을 strategy별로 분리',
    });
  }
  const advisories = sourceHealth.warnings || [];
  if (advisories.length > 0) {
    watch.push({
      id: 'source_health_advisory',
      severity: 'advisory',
      summary: '소스 상태는 guarded지만 대형 파일 경고가 있습니다.',
      evidence: advisories.slice(0, 8),
      nextAction: '핫패스 파일만 우선 분리하고, large-file advisory는 로드맵 경고로 유지',
    });
  }
  return watch;
}

function collectWarnings({ actionBoard = {} } = {}) {
  return unique(actionBoard.operationalWarnings || []);
}

export function buildLunaProcessIntegrityLoopReport({
  actionBoard = {},
  tradeData = {},
  sourceHealth = {},
  finalGate = {},
  generatedAt = new Date().toISOString(),
} = {}) {
  const hardBlockers = collectHardBlockers({ actionBoard, tradeData, sourceHealth, finalGate });
  const watchItems = collectWatchItems({ tradeData, sourceHealth });
  const actionableWatchItems = watchItems.filter((item) => item.severity !== 'advisory');
  const warnings = collectWarnings({ actionBoard });
  const prefilterRemediationPlan = buildPrefilterRemediationPlan(tradeData.signals?.blockedReasons || [], 6);
  const status = hardBlockers.length > 0
    ? 'process_integrity_blocked'
    : actionableWatchItems.length > 0
      ? 'process_integrity_watch'
      : watchItems.length > 0
        ? 'process_integrity_advisory'
        : 'process_integrity_clear';
  return {
    ok: hardBlockers.length === 0,
    status,
    generatedAt,
    readOnly: true,
    liveTradeImpact: false,
    hardBlockers,
    warnings,
    watchItems,
    prefilterRemediationPlan,
    summary: {
      operationalStatus: actionBoard.sourceStatus || null,
      liveFireStatus: finalGate.status || actionBoard.liveFire?.status || null,
      tradeDataStatus: tradeData.status || null,
      hygieneStatus: tradeData.hygiene?.status || null,
      sourceHealthStatus: sourceHealth.status || null,
      signalExecutionRate: tradeData.signals?.executionRate ?? null,
      signalPolicyAdjustedExecutionRate: tradeData.signals?.policyAdjustedExecutionRate ?? null,
      signalPolicyBlockedSignals: tradeData.signals?.policyBlockedSignals ?? null,
      signalExecutionCandidateSignals: tradeData.signals?.executionCandidateSignals ?? null,
      signalFailureRate: tradeData.signals?.failureRate ?? null,
      openJournalStatus: tradeData.hygiene?.openJournal?.status || null,
      realizedPnlCoverage: tradeData.hygiene?.realizedPnlCoverage?.coverage ?? tradeData.trades?.realizedPnlCoverage?.coverage ?? null,
      posttradeQualityCoverage: tradeData.hygiene?.qualityCoverage?.coverage ?? tradeData.posttrade?.qualityCoverage?.coverage ?? null,
      actionableWatchCount: actionableWatchItems.length,
      advisoryCount: watchItems.length - actionableWatchItems.length,
    },
    loopDecision: {
      analyze: 'completed',
      modify: hardBlockers.length > 0 ? 'operator_approval_required_for_hard_blockers' : 'safe_code_or_policy_refinement_only',
      test: 'rerun_process_integrity_loop_and_relevant_smoke',
    },
      nextActions: hardBlockers.length > 0
      ? [
        'hard blocker evidence를 먼저 확인하고 명시 승인 전에는 reconcile/apply/rollback을 실행하지 않음',
        ...(actionBoard.nextActions || []),
      ]
      : [
        ...remediationNextActions(prefilterRemediationPlan),
        ...watchItems.map((item) => item.nextAction).filter(Boolean),
        ...remediationCommands(prefilterRemediationPlan),
        'npm --prefix bots/investment run -s smoke:luna-process-integrity-loop',
        'npm --prefix bots/investment run -s runtime:luna-process-integrity-loop -- --json',
      ],
  };
}

async function runLunaProcessIntegrityLoopOnce(options = {}) {
  const exchange = options.exchange || 'binance';
  const hours = Number(options.hours || 24);
  const limit = Number(options.limit || 5000);
  const [rawActionBoard, tradeData, sourceHealth, finalGate] = await Promise.all([
    runLunaOperationalActionBoard({ exchange, hours, days: 7 }),
    buildTradeDataAnalysisReport({ limit }),
    Promise.resolve(buildLunaSourceHealthAudit()),
    buildLunaLiveFireFinalGate({ exchange, hours: Math.min(hours, 24), liveLookup: false, withPositionParity: true }),
  ]);
  let actionBoard = rawActionBoard;
  if ((rawActionBoard.hardBlockers || []).some(isAgentBusQueryFailedBlocker)) {
    const busHygieneRetry = await runAgentMessageBusHygiene({
      staleHours: 6,
      limit: 100,
      apply: false,
      dryRun: true,
      suppressAlert: true,
    }).catch((error) => ({ ok: false, status: 'agent_message_bus_hygiene_retry_failed', error: error?.message || String(error) }));
    actionBoard = normalizeActionBoardAgentBusQueryFailure(rawActionBoard, busHygieneRetry);
  }
  return buildLunaProcessIntegrityLoopReport({ actionBoard, tradeData, sourceHealth, finalGate });
}

export async function runLunaProcessIntegrityLoop(options = {}) {
  if (options.smoke) return runLunaProcessIntegrityLoopSmoke();
  const retryCount = Math.max(0, Math.min(3, Number(options.retryCount ?? 2) || 0));
  let lastError = null;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    try {
      const report = await runLunaProcessIntegrityLoopOnce(options);
      if (attempt > 0) {
        const message = errorMessage(lastError);
        report.warnings = unique([
          ...(report.warnings || []),
          `process_integrity_retry_recovered:${message}`,
        ]);
        report.retry = {
          recovered: true,
          attempts: attempt + 1,
          previousError: message,
        };
      }
      return report;
    } catch (error) {
      lastError = error;
      if (!isTransientProcessIntegrityError(error) || attempt >= retryCount) throw error;
      await sleep(1200 * (attempt + 1));
    }
  }
  throw lastError;
}

export async function runLunaProcessIntegrityLoopSmoke() {
  const report = buildLunaProcessIntegrityLoopReport({
    actionBoard: {
      sourceStatus: 'operational_clear',
      hardBlockers: [],
      manualReconcile: { count: 0 },
      exchangeLookupRetry: { count: 0 },
      ackQueue: { count: 0 },
    },
    finalGate: { status: 'luna_live_fire_final_gate_clear', blockers: [] },
    sourceHealth: { status: 'luna_source_health_guarded', blockers: [], warnings: ['large_file_advisory:team/luna.ts:1401'] },
    tradeData: {
      status: 'ready',
      signals: {
        total: 10,
        executionRate: 0.5,
        failureRate: 0,
        blockedReasons: [
          { reason: 'capital_guard_rejected', count: 4 },
          { reason: 'sec015_overseas_stale_approval', count: 2 },
        ],
      },
      hygiene: {
        status: 'ready',
        findings: [],
        openJournal: { status: 'ready' },
        realizedPnlCoverage: { coverage: 1 },
        qualityCoverage: { coverage: 1 },
      },
      journal: {
        strategyFamily: {
          buckets: [{ name: 'trend_following', closed: 4, avgPnlPercent: -1.2, winRate: 0.25 }],
        },
        earlyExit: { underOneHour: true, total: 3, losses: 2, samples: [{ symbol: 'BTC/USDT', holdMinutes: 12, pnlPercent: -1.1 }] },
      },
    },
    generatedAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(report.ok, true);
  assert.equal(report.status, 'process_integrity_watch');
  assert.ok(report.watchItems.some((item) => item.id === 'signal_block_reason_prefilter_review'));
  assert.ok(report.watchItems.some((item) => item.id === 'weak_strategy_family_review'));
  assert.ok(report.prefilterRemediationPlan.some((item) => item.reason === 'capital_guard_rejected' && item.stage === 'capital_preflight'));
  assert.ok(report.prefilterRemediationPlan.some((item) => item.reason === 'sec015_overseas_stale_approval' && item.stage === 'approval_freshness_preflight'));
  assert.ok(report.nextActions.some((item) => item.includes('runtime:binance-failure-pressure')));
  assert.ok(report.nextActions.some((item) => item.includes('runtime:execution-risk-guard')));
  assert.ok(report.nextActions.some((item) => item.includes('runtime:luna-process-integrity-loop')));

  const cooledPolicyBlocks = buildLunaProcessIntegrityLoopReport({
    actionBoard: { sourceStatus: 'operational_clear', hardBlockers: [] },
    finalGate: { status: 'luna_live_fire_final_gate_clear', blockers: [] },
    sourceHealth: { status: 'luna_source_health_guarded', blockers: [], warnings: [] },
    tradeData: {
      status: 'ready',
      signals: {
        total: 10,
        executionRate: 0.5,
        policyAdjustedExecutionRate: 0.85,
        blockedReasons: [{ reason: 'capital_guard_rejected', count: 4 }],
        blockedReasonTrend: {
          last24h: {
            total: 1,
            expected: 1,
            unexpected: 0,
            blockedReasons: [{ reason: 'capital_guard_rejected', count: 1 }],
          },
          last2h: {
            total: 0,
            expected: 0,
            unexpected: 0,
            blockedReasons: [],
          },
        },
      },
      hygiene: { status: 'ready', findings: [] },
      journal: {},
    },
  });
  const cooledSignalWatch = cooledPolicyBlocks.watchItems.find((item) => item.id === 'signal_block_reason_prefilter_review');
  assert.equal(cooledPolicyBlocks.status, 'process_integrity_advisory');
  assert.equal(cooledSignalWatch?.severity, 'advisory');
  assert.equal(cooledSignalWatch?.evidence?.recentPolicyCoverage?.totals?.last2h, 0);

  const normalizedBus = normalizeActionBoardAgentBusQueryFailure({
    sourceStatus: 'operational_blocked',
    hardBlockers: ['agent_message_bus_hygiene:query_failed'],
    manualReconcile: { count: 0 },
    exchangeLookupRetry: { count: 0 },
    ackQueue: { count: 0 },
  }, {
    ok: true,
    status: 'agent_message_bus_hygiene_clear',
    before: { staleCount: 0 },
    reviewReport: { reviewRequired: 0, safeExpire: 0 },
  });
  assert.equal(normalizedBus.hardBlockers.includes('agent_message_bus_hygiene:query_failed'), false);
  assert.equal(normalizedBus.sourceStatus, 'operational_clear_after_retry');
  assert.equal(normalizedBus.originalSourceStatus, 'operational_blocked');
  assert.ok(normalizedBus.operationalWarnings.includes('agent_message_bus_hygiene_query_failed_retry_clear'));

  const retryFailedBus = normalizeActionBoardAgentBusQueryFailure({
    sourceStatus: 'operational_blocked',
    hardBlockers: ['agent_message_bus_hygiene:query_failed'],
  }, { ok: false, status: 'agent_message_bus_hygiene_retry_failed' });
  assert.ok(retryFailedBus.hardBlockers.includes('agent_message_bus_hygiene:query_failed'));
  assert.ok(retryFailedBus.operationalWarnings.includes('agent_message_bus_hygiene_query_failed_retry_failed'));

  const blocked = buildLunaProcessIntegrityLoopReport({
    actionBoard: { sourceStatus: 'operational_blocked', hardBlockers: ['reconcile:BTC/USDT:manual_reconcile_required'], manualReconcile: { count: 1 } },
    finalGate: { status: 'blocked', blockers: ['manual_reconcile_tasks:1'] },
    sourceHealth: { status: 'luna_source_health_guarded', blockers: [], warnings: [] },
    tradeData: { hygiene: { findings: [] }, signals: {}, journal: {} },
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 'process_integrity_blocked');
  assert.ok(blocked.hardBlockers.some((item) => item.includes('manual_reconcile')));

  const hygieneAdvisory = buildLunaProcessIntegrityLoopReport({
    actionBoard: { sourceStatus: 'operational_clear', hardBlockers: [] },
    finalGate: { status: 'luna_live_fire_final_gate_clear', blockers: [] },
    sourceHealth: { status: 'luna_source_health_guarded', blockers: [], warnings: [] },
    tradeData: {
      status: 'needs_attention',
      signals: { total: 0, blockedReasons: [] },
      hygiene: {
        status: 'needs_attention',
        findings: [{
          id: 'realized_pnl_backfill_pending',
          severity: 'P1',
          reason: 'closed sell trades are missing realized_pnl_pct and will weaken learning labels',
        }],
      },
      journal: {},
    },
  });
  assert.equal(hygieneAdvisory.ok, true);
  assert.equal(hygieneAdvisory.hardBlockers.includes('trade_data_hygiene:realized_pnl_backfill_pending'), false);
  assert.ok(hygieneAdvisory.watchItems.some((item) => item.id === 'trade_data_hygiene_advisory_backlog'));
  assert.equal(
    hygieneAdvisory.hardBlockers.some((item) => item.includes('closed sell trades are missing')),
    false,
  );
  return { ok: true, report, blocked };
}

async function main() {
  const result = await runLunaProcessIntegrityLoop({
    smoke: hasFlag('--smoke'),
    exchange: argValue('--exchange', 'binance'),
    hours: Number(argValue('--hours', 24)),
    limit: Number(argValue('--limit', 5000)),
    retryCount: Number(argValue('--retry', 2)),
  });
  if (hasFlag('--json')) console.log(JSON.stringify(result, null, 2));
  else if (hasFlag('--smoke')) console.log('luna process integrity loop smoke ok');
  else console.log(`${result.status} hard=${result.hardBlockers.length} watch=${result.watchItems.length}`);
  if (!hasFlag('--smoke') && hasFlag('--fail-on-blocked') && result.ok === false) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna process integrity loop 실패:',
  });
}
