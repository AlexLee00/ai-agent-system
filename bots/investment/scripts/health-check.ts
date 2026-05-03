// @ts-nocheck
/**
 * scripts/health-check.js — 루나팀 launchd 서비스 헬스체크
 *
 * 감지 대상:
 *   - 상시 실행: commander, crypto, domestic, overseas, argos (PID 없으면 다운)
 *   - 스케줄: market-alert-*, prescreen-*, reporter
 *
 * 공통 상태: packages/core/lib/health-state-manager.js
 * 실행: node scripts/health-check.js
 * 자동: launchd ai.investment.health-check (10분마다)
 */

import { execSync } from 'child_process';
import fs from 'node:fs';
import { createRequire } from 'module';
import { publishAlert } from '../shared/alert-publisher.ts';
import { validateTradeReview } from './validate-trade-review.ts';
import { buildRuntimeLearningLoopReport } from './runtime-learning-loop-report.ts';
import { runCollectionAudit } from './runtime-collection-audit.ts';
import { runPositionRuntimeReport } from './runtime-position-runtime-report.ts';
import { runPositionRuntimeTuning } from './runtime-position-runtime-tuning.ts';
import { runPositionRuntimeDispatch } from './runtime-position-runtime-dispatch.ts';
import { backfillTradeIncidentLinks } from './backfill-trade-incident-links.ts';
import { buildPositionStrategyHygieneRemediationPlan, runPositionStrategyHygiene } from './runtime-position-strategy-hygiene.ts';
import { runPositionStrategyRemediation } from './runtime-position-strategy-remediation.ts';
import { loadExecutionRiskApprovalGuardHealth } from './health-report-support.ts';
import { launchdDomain, runLaunchctl } from '../shared/launchd-service.ts';
import {
  enrichAutonomousActionAlertPayload,
  resolveAutonomousActionAlertEventType,
} from '../shared/autonomous-action-event.ts';

const require = createRequire(import.meta.url);
const hsm     = require('../../../packages/core/lib/health-state-manager');
const pgPool  = require('../../../packages/core/lib/pg-pool');
const {
  getServiceOwnership,
  isElixirOwnedService,
  isRetiredService,
} = require('../../../packages/core/lib/service-ownership');
const { createHealthMemoryHelper } = require('../shared/health-memory-bridge.cjs');
const { buildIssueHints, rememberHealthEvent } = createHealthMemoryHelper({
  agentId: 'investment.health',
  team: 'investment',
  domain: 'investment health',
});

// 상시 실행 서비스 (PID 있어야 정상) — KeepAlive=true인 데몬만
const CONTINUOUS = [
  'ai.investment.commander',
  // crypto: StartInterval 300s, KeepAlive=false → 스케줄 봇
  // domestic: StartCalendarInterval, KeepAlive=false → 스케줄 봇
  // overseas: StartCalendarInterval, KeepAlive=false → 스케줄 봇
  // argos: StartCalendarInterval, KeepAlive=false → 스케줄 봇
];

// 감지할 전체 서비스
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

// 정상 종료 코드
const NORMAL_EXIT_CODES = new Set([0, -9, -15]);
const LOCAL_LLM_HEALTH_HISTORY_FILE = '/tmp/investment-local-llm-health-history.jsonl';
const LATEST_OPS_SNAPSHOT_FILE = '/Users/alexlee/projects/ai-agent-system/bots/investment/output/ops/parallel-ops-snapshot.json';
const LATEST_OPS_SNAPSHOT_STALE_HOURS = 24;
const INVESTMENT_BOT_PREFIX = '/Users/alexlee/projects/ai-agent-system/bots/investment';
const MCP_HEALTH_CHECK_TIMEOUT_MS = 25_000;
const MCP_HEALTH_PROBES = [
  {
    key: 'mcp-health-kis',
    label: 'KIS',
    command: `npm --prefix ${INVESTMENT_BOT_PREFIX} run kis-mcp:test`,
    nextCommand: `npm --prefix ${INVESTMENT_BOT_PREFIX} run kis-mcp:test`,
  },
  {
    key: 'mcp-health-binance',
    label: 'Binance',
    command: `npm --prefix ${INVESTMENT_BOT_PREFIX} run binance-mcp:test`,
    nextCommand: `npm --prefix ${INVESTMENT_BOT_PREFIX} run binance-mcp:test`,
  },
];

function loadLatestOpsSnapshot() {
  try {
    if (!fs.existsSync(LATEST_OPS_SNAPSHOT_FILE)) return null;
    return JSON.parse(fs.readFileSync(LATEST_OPS_SNAPSHOT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function getSnapshotAgeHours(capturedAt) {
  const ts = capturedAt ? new Date(capturedAt).getTime() : NaN;
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.round(((Date.now() - ts) / 3600000) * 10) / 10);
}

function formatSnapshotSummary(snapshot, weakest, weakestMode) {
  if (!snapshot?.capturedAt) return null;
  const ageHours = getSnapshotAgeHours(snapshot.capturedAt);
  const ageText = ageHours == null ? 'age n/a' : ageHours < 24 ? `${ageHours.toFixed(1)}h ago` : `${(ageHours / 24).toFixed(1)}d ago`;
  const prefix = ageHours != null && ageHours > LATEST_OPS_SNAPSHOT_STALE_HOURS ? 'stale snapshot' : 'latest snapshot';
  return `${prefix}: ${snapshot.capturedAt} / ${weakest?.regime || 'n/a'} / ${weakestMode} / ${ageText}`;
}

function getWeakestRegimeSummary(runtimeLearningLoop) {
  const weakest = runtimeLearningLoop?.sections?.regimeLaneSummary?.weakestRegime
    || runtimeLearningLoop?.sections?.collect?.regimePerformance?.weakestRegime
    || null;
  const weakestMode = weakest?.tradeMode || weakest?.worstMode?.tradeMode || weakest?.bestMode?.tradeMode || 'n/a';
  return { weakest, weakestMode };
}

function toComparableSuggestionValue(value) {
  if (value == null || value === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  return String(value);
}

function isAlreadyAppliedSuggestion(topSuggestion = null) {
  if (!topSuggestion) return false;
  const currentValue = toComparableSuggestionValue(topSuggestion?.current ?? topSuggestion?.governance?.current);
  const suggestedValue = toComparableSuggestionValue(topSuggestion?.suggestedValue ?? topSuggestion?.suggested);
  if (currentValue == null || suggestedValue == null) return false;
  return currentValue === suggestedValue;
}

function buildHealthCheckRemediationView(remediation, hygiene, remediationHistory = null) {
  const remediationPlan = remediation?.remediationPlan || hygiene?.remediationPlan || buildPositionStrategyHygieneRemediationPlan(hygiene);
  const remediationFlat = remediation?.remediationFlat || null;
  const remediationSummary = remediation?.remediationSummary || null;
  const remediationStatus = remediation?.remediationStatus || remediationFlat?.status || remediationSummary?.status || null;
  const remediationHeadline = remediation?.remediationHeadline || remediationFlat?.headline || remediationSummary?.headline || remediation?.decision?.headline || hygiene?.decision?.headline || '포지션 전략 remediation 후보 감지';
  const remediationCounts = remediation?.remediationCounts || remediationFlat?.counts || remediationSummary?.counts || null;
  const remediationDuplicateManaged = remediation?.remediationDuplicateManaged ?? remediationFlat?.duplicateManaged ?? remediationCounts?.duplicateManaged ?? hygiene?.audit?.duplicateManagedProfileScopes ?? 0;
  const remediationOrphanProfiles = remediation?.remediationOrphanProfiles ?? remediationFlat?.orphanProfiles ?? remediationCounts?.orphanProfiles ?? hygiene?.audit?.orphanProfiles ?? 0;
  const remediationUnmatchedManaged = remediation?.remediationUnmatchedManaged ?? remediationFlat?.unmatchedManaged ?? remediationCounts?.unmatchedManaged ?? hygiene?.audit?.unmatchedManagedPositions ?? 0;
  const remediationCommandsBase = remediation?.remediationCommands || remediationFlat?.commands || remediationSummary?.commands || null;
  const remediationRefreshState = remediation?.remediationRefreshState || remediationFlat?.refresh || remediationSummary?.refreshState || null;
  const remediationRefreshNeeded = remediation?.remediationRefreshNeeded ?? remediationFlat?.refreshNeeded ?? remediationRefreshState?.needed ?? null;
  const remediationRefreshStale = remediation?.remediationRefreshStale ?? remediationFlat?.refreshStale ?? remediationRefreshState?.stale ?? null;
  const remediationRefreshReason = remediation?.remediationRefreshReason || remediationFlat?.refreshReason || remediationRefreshState?.reason || null;
  const remediationRefreshCommand = remediation?.remediationRefreshCommand || remediationFlat?.refreshCommand || remediationCommandsBase?.refresh || remediationRefreshState?.command || null;
  const remediationTrend = remediation?.remediationTrend
    || (remediationFlat?.trendHistoryCount !== undefined
      ? {
        historyCount: remediationFlat?.trendHistoryCount,
        statusChanged: remediationFlat?.trendChanged,
        nextCommandChanged: remediationFlat?.trendNextChanged ?? remediationFlat?.nextCommandChanged,
        nextCommandTransition: remediation?.remediationNextCommandTransition || remediationFlat?.nextCommandTransition || remediationSummary?.nextCommandTransition || null,
        ageMinutes: remediationFlat?.trendAgeMinutes,
        stale: remediationFlat?.trendStale,
        duplicateDelta: remediationFlat?.trendDuplicateDelta,
        orphanDelta: remediationFlat?.trendOrphanDelta,
        unmatchedDelta: remediationFlat?.trendUnmatchedDelta,
      }
      : null)
    || remediationFlat?.trend
    || remediationSummary?.trend
    || null;
  const remediationNextCommand = remediation?.remediationNextCommand || remediationFlat?.nextCommand || remediationPlan?.remediationReportCommand || 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-strategy-remediation -- --json';
  const remediationNextCommandTransition = remediation?.remediationNextCommandTransition || remediationFlat?.nextCommandTransition || remediationTrend?.nextCommandTransition || remediationSummary?.nextCommandTransition || null;
  const remediationNextCommandChanged = remediation?.remediationNextCommandChanged ?? remediationFlat?.nextCommandChanged ?? remediationTrend?.nextCommandChanged ?? null;
  const remediationNextCommandPrevious = remediation?.remediationNextCommandPrevious || remediationFlat?.nextCommandPrevious || remediationNextCommandTransition?.previous || null;
  const remediationNextCommandCurrent = remediation?.remediationNextCommandCurrent || remediationFlat?.nextCommandCurrent || remediationNextCommandTransition?.current || null;
  const recommendedExchange = remediation?.remediationRecommendedExchange || remediationFlat?.recommendedExchange || remediationSummary?.recommendedExchange || remediationPlan?.recommendedExchange || null;
  const remediationActionReportCommand = remediation?.remediationActionReportCommand || remediationFlat?.actionReportCommand || remediationCommandsBase?.report || remediationSummary?.actions?.reportCommand || null;
  const remediationActionAutonomousApplyCommand = remediation?.remediationActionAutonomousApplyCommand || remediationFlat?.actionAutonomousApplyCommand || remediationCommandsBase?.autonomousApply || remediationSummary?.actions?.autonomousApplyCommand || remediationPlan?.remediationAutonomousApplyCommand || null;
  const remediationActionHistoryCommand = remediation?.remediationActionHistoryCommand || remediationFlat?.actionHistoryCommand || remediationCommandsBase?.history || remediationSummary?.actions?.historyCommand || null;
  const remediationActionRefreshCommand = remediation?.remediationActionRefreshCommand || remediationFlat?.actionRefreshCommand || remediationRefreshCommand || remediationSummary?.actions?.refreshCommand || null;
  const remediationActionHygieneCommand = remediation?.remediationActionHygieneCommand || remediationFlat?.actionHygieneCommand || remediationCommandsBase?.hygiene || remediationSummary?.actions?.hygieneCommand || null;
  const remediationActionNormalizeDryRunCommand = remediation?.remediationActionNormalizeDryRunCommand || remediationFlat?.actionNormalizeDryRunCommand || remediationCommandsBase?.normalizeDryRun || remediationSummary?.actions?.normalizeDryRunCommand || null;
  const remediationActionNormalizeApplyCommand = remediation?.remediationActionNormalizeApplyCommand || remediationFlat?.actionNormalizeApplyCommand || remediationCommandsBase?.normalizeApply || remediationSummary?.actions?.normalizeApplyCommand || null;
  const remediationActionRetireDryRunCommand = remediation?.remediationActionRetireDryRunCommand || remediationFlat?.actionRetireDryRunCommand || remediationCommandsBase?.retireDryRun || remediationSummary?.actions?.retireDryRunCommand || null;
  const remediationActionRetireApplyCommand = remediation?.remediationActionRetireApplyCommand || remediationFlat?.actionRetireApplyCommand || remediationCommandsBase?.retireApply || remediationSummary?.actions?.retireApplyCommand || null;
  const remediationAutonomousStatus = remediation?.remediationAutonomousStatus || remediation?.remediationAutonomous?.status || 'autonomous_action_blocked_by_safety';
  const remediationAutonomousReason = remediation?.remediationAutonomousReason || remediation?.remediationAutonomous?.reason || null;
  const remediationAutonomousContext = remediation?.remediationAutonomousContext || remediation?.remediationAutonomous?.context || null;
  const remediationObservationHint = !remediationRefreshStale && remediationAutonomousReason === 'autonomous_apply_disabled'
    ? 'history는 최신이며 자동 apply는 비활성 상태입니다. normalize/retire dry-run으로 duplicate·orphan 후보를 계속 관찰합니다.'
    : (!remediationRefreshStale && remediationAutonomousContext?.stableEnough === true && remediationAutonomousContext?.safeEnough === false
      ? `history는 최신이며 safe cycle이 아직 부족합니다. duplicate ${remediationAutonomousContext?.duplicateConsecutiveSafeCycles || 0}/${remediationAutonomousContext?.safeCycles || 'n/a'}, orphan ${remediationAutonomousContext?.orphanConsecutiveSafeCycles || 0}/${remediationAutonomousContext?.safeCycles || 'n/a'}.`
      : null);
  const remediationCommands = {
    report: remediationActionReportCommand || null,
    autonomousApply: remediationActionAutonomousApplyCommand || null,
    history: remediationActionHistoryCommand || null,
    refresh: remediationRefreshCommand || remediationActionRefreshCommand || null,
    hygiene: remediationActionHygieneCommand || null,
    normalizeDryRun: remediationActionNormalizeDryRunCommand || null,
    normalizeApply: remediationActionNormalizeApplyCommand || null,
    retireDryRun: remediationActionRetireDryRunCommand || null,
    retireApply: remediationActionRetireApplyCommand || null,
  };
  const remediationActions = {
    reportCommand: remediationActionReportCommand || null,
    autonomousApplyCommand: remediationActionAutonomousApplyCommand || null,
    historyCommand: remediationActionHistoryCommand || null,
    refreshCommand: remediationActionRefreshCommand || remediationRefreshCommand || null,
    hygieneCommand: remediationActionHygieneCommand || null,
    normalizeDryRunCommand: remediationActionNormalizeDryRunCommand || null,
    normalizeApplyCommand: remediationActionNormalizeApplyCommand || null,
    retireDryRunCommand: remediationActionRetireDryRunCommand || null,
    retireApplyCommand: remediationActionRetireApplyCommand || null,
  };
  return {
    remediationPlan,
    remediationFlat,
    remediationSummary,
    remediationStatus,
    remediationHeadline,
    remediationCounts,
    remediationDuplicateManaged,
    remediationOrphanProfiles,
    remediationUnmatchedManaged,
    remediationCommands,
    remediationActions,
    remediationRefreshState,
    remediationRefreshNeeded,
    remediationRefreshStale,
    remediationRefreshReason,
    remediationRefreshCommand,
    remediationTrend,
    remediationTrendHistoryCount: remediation?.remediationTrendHistoryCount ?? remediationFlat?.trendHistoryCount ?? remediationTrend?.historyCount ?? null,
    remediationTrendChanged: remediation?.remediationTrendChanged ?? remediationFlat?.trendChanged ?? remediationTrend?.statusChanged ?? null,
    remediationTrendNextChanged: remediation?.remediationTrendNextChanged ?? remediationFlat?.trendNextChanged ?? remediationTrend?.nextCommandChanged ?? null,
    remediationTrendAgeMinutes: remediation?.remediationTrendAgeMinutes ?? remediationFlat?.trendAgeMinutes ?? remediationTrend?.ageMinutes ?? null,
    remediationTrendStale: remediation?.remediationTrendStale ?? remediationFlat?.trendStale ?? remediationTrend?.stale ?? null,
    remediationTrendDuplicateDelta: remediation?.remediationTrendDuplicateDelta ?? remediationFlat?.trendDuplicateDelta ?? remediationTrend?.duplicateDelta ?? null,
    remediationTrendOrphanDelta: remediation?.remediationTrendOrphanDelta ?? remediationFlat?.trendOrphanDelta ?? remediationTrend?.orphanDelta ?? null,
    remediationTrendUnmatchedDelta: remediation?.remediationTrendUnmatchedDelta ?? remediationFlat?.trendUnmatchedDelta ?? remediationTrend?.unmatchedDelta ?? null,
    remediationNextCommand,
    remediationNextCommandTransition,
    remediationNextCommandChanged,
    remediationNextCommandPrevious,
    remediationNextCommandCurrent,
    recommendedExchange,
    remediationHistory: remediationHistory || null,
    remediationActionReportCommand,
    remediationActionAutonomousApplyCommand,
    remediationActionHistoryCommand,
    remediationActionRefreshCommand,
    remediationActionHygieneCommand,
    remediationActionNormalizeDryRunCommand,
    remediationActionNormalizeApplyCommand,
    remediationActionRetireDryRunCommand,
    remediationActionRetireApplyCommand,
    remediationAutonomousStatus,
    remediationAutonomousReason,
    remediationAutonomousContext,
    remediationObservationHint,
    remediationReportCommand: remediationCommands.report || remediationActionReportCommand || null,
    remediationHistoryCommand: remediationCommands.history || remediationActionHistoryCommand || null,
    remediationNormalizeDryRunCommand: remediationCommands.normalizeDryRun || remediationActionNormalizeDryRunCommand || null,
    remediationNormalizeApplyCommand: remediationCommands.normalizeApply || remediationActionNormalizeApplyCommand || null,
    remediationRetireDryRunCommand: remediationCommands.retireDryRun || remediationActionRetireDryRunCommand || null,
    remediationRetireApplyCommand: remediationCommands.retireApply || remediationActionRetireApplyCommand || null,
  };
}

function buildHealthCheckRuntimeView(runtimeReport, runtimeTuning, runtimeDispatch) {
  let marketQueueEntries = Array.isArray(runtimeDispatch?.marketQueue?.entries) ? runtimeDispatch.marketQueue.entries : [];
  if (!marketQueueEntries.length && runtimeDispatch?.marketQueue?.file && fs.existsSync(runtimeDispatch.marketQueue.file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(runtimeDispatch.marketQueue.file, 'utf8'));
      marketQueueEntries = Array.isArray(parsed?.entries) ? parsed.entries : [];
    } catch {}
  }
  const waitingEntries = marketQueueEntries.filter((entry) => String(entry?.waitingReason || '').includes('장외'));
  const retryEntries = marketQueueEntries.filter((entry) => String(entry?.waitingReason || '') === 'retry_scheduled');
  const waitingSample = waitingEntries[0]
    ? `${waitingEntries[0]?.candidate?.exchange || 'n/a'}/${waitingEntries[0]?.candidate?.symbol || 'n/a'} (${waitingEntries[0]?.waitingReason || 'market_wait'})`
    : null;
  const retrySample = retryEntries.length > 0
    ? retryEntries
      .slice(0, 2)
      .map((entry) => `${entry?.candidate?.exchange || 'n/a'}/${entry?.candidate?.symbol || 'n/a'} (${entry?.reason || 'retry'})`)
      .join(', ')
    : null;
  const decision = runtimeReport?.decision || {};
  const metrics = decision.metrics || {};
  const suggestions = Array.isArray(runtimeTuning?.suggestions) ? runtimeTuning.suggestions : [];
  const topSuggestion = suggestions[0] || null;
  const candidates = Array.isArray(runtimeDispatch?.candidates) ? runtimeDispatch.candidates : [];
  const dispatchResults = Array.isArray(runtimeDispatch?.results) ? runtimeDispatch.results : [];
  const queuedCount = dispatchResults.filter((item) => item?.autonomousActionStatus === 'autonomous_action_queued').length
    + Number(runtimeDispatch?.marketQueue?.waitingMarketOpen || 0);
  const retryingCount = dispatchResults.filter((item) => item?.autonomousActionStatus === 'autonomous_action_retrying').length
    + Number(runtimeDispatch?.marketQueue?.retrying || 0);
  const failedCount = dispatchResults.filter((item) => item?.autonomousActionStatus === 'autonomous_action_failed').length;
  const executedCount = dispatchResults.filter((item) => item?.autonomousActionStatus === 'autonomous_action_executed').length;
  const autonomousActionStatus = failedCount > 0
    ? 'autonomous_action_failed'
    : retryingCount > 0
      ? 'autonomous_action_retrying'
      : queuedCount > 0 || candidates.length > 0
        ? 'autonomous_action_queued'
        : runtimeDispatch?.status === 'position_runtime_dispatch_blocked'
          ? 'autonomous_action_blocked_by_safety'
          : executedCount > 0
            ? 'autonomous_action_executed'
            : 'autonomous_action_blocked_by_safety';
  return {
    status: decision.status || 'position_runtime_unknown',
    headline: decision.headline || 'runtime state unavailable',
    metrics: {
      total: Number(metrics.total || 0),
      active: Number(metrics.active || 0),
      exitReady: Number(metrics.exitReady || 0),
      adjustReady: Number(metrics.adjustReady || 0),
      staleValidation: Number(metrics.staleValidation || 0),
      fastLane: Number(metrics.fastLane || 0),
    },
    tuningStatus: runtimeTuning?.status || 'position_runtime_tuning_unknown',
    tuningSuggestion: topSuggestion,
    dispatchStatus: runtimeDispatch?.status || 'position_runtime_dispatch_unknown',
    dispatchCandidates: candidates.length,
    dispatchTopCandidate: candidates[0] || null,
    dispatchQueuedCount: queuedCount,
    dispatchRetryingCount: retryingCount,
    dispatchFailedCount: failedCount,
    dispatchExecutedCount: executedCount,
    marketQueue: runtimeDispatch?.marketQueue || null,
    marketQueueWaitingSample: waitingSample,
    marketQueueRetrySample: retrySample,
    autonomousActionStatus,
    reportCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime -- --json',
    tuningCommand: topSuggestion?.exchange
      ? `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-tuning -- --exchange=${topSuggestion.exchange} --json`
      : 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-tuning -- --json',
    dispatchCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-dispatch -- --json',
    autotuneCommand: topSuggestion?.exchange
      ? `npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-autotune -- --exchange=${topSuggestion.exchange} --apply --confirm=runtime-autotune --json`
      : 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-autotune -- --apply --confirm=runtime-autotune --json',
    autopilotCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-autopilot -- --execute --apply-tuning --execute-dispatch --confirm=position-runtime-autopilot --json',
  };
}

// ─── 알림 발송 ───────────────────────────────────────────────────

async function notify(msg, level = 3, payload = null) {
  const normalizedPayload = enrichAutonomousActionAlertPayload(
    payload && typeof payload === 'object' ? payload : null,
    msg,
  );
  const eventType = resolveAutonomousActionAlertEventType(normalizedPayload, 'health_check');
  const alertContract = resolveHealthCheckAlertContract(msg, level, normalizedPayload, eventType);
  try {
    await publishAlert({
      from_bot: 'luna-health-check',
      event_type: eventType,
      alert_level: level,
      message: msg,
      payload: normalizedPayload || undefined,
      visibility: alertContract.visibility,
      alarm_type: alertContract.alarmType,
      actionability: alertContract.actionability,
      incident_key: alertContract.incidentKey,
      title: alertContract.title,
    });
  } catch { /* 무시 */ }
}

function extractHealthCheckTitle(message = '') {
  const firstLine = String(message || '')
    .split('\n')
    .map((line) => String(line || '').trim())
    .find(Boolean);
  return firstLine || 'investment health check';
}

function resolveHealthCheckAlertContract(message = '', level = 3, payload = null, eventType = 'health_check') {
  const issueKey = String(payload?.issueKey || '').trim();
  const autonomousActionStatus = String(
    payload?.autonomousActionStatus
    || payload?.positionRuntimeAutonomousActionStatus
    || payload?.remediationAutonomousStatus
    || '',
  ).trim().toLowerCase();
  const incidentKey = issueKey
    ? `investment:luna-health-check:${eventType}:${issueKey}`
    : `investment:luna-health-check:${eventType}`;
  const title = extractHealthCheckTitle(message);

  const base = {
    alarmType: level >= 3 ? 'error' : 'report',
    visibility: level >= 3 ? 'notify' : 'digest',
    actionability: level >= 3 ? 'auto_repair' : 'none',
    incidentKey,
    title,
  };

  if (issueKey === 'trade-incident-link-integrity') {
    return {
      ...base,
      alarmType: 'report',
      visibility: 'internal',
      actionability: 'none',
    };
  }

  if (issueKey === 'trade-review-integrity') {
    return {
      ...base,
      alarmType: 'report',
      visibility: 'digest',
      actionability: 'none',
    };
  }

  if (issueKey === 'learning-loop-regime-monitor') {
    return {
      ...base,
      alarmType: 'report',
      visibility: 'internal',
      actionability: 'none',
    };
  }

  if (
    issueKey === 'position-strategy-remediation'
    && (
      autonomousActionStatus === 'autonomous_action_blocked_by_safety'
      || payload?.remediationRefreshStale === true
    )
  ) {
    return {
      ...base,
      alarmType: 'report',
      visibility: 'digest',
      actionability: 'none',
    };
  }

  if (issueKey === 'position-runtime-loop') {
    const runtimeMetrics = payload?.positionRuntimeMetrics || payload?.positionRuntimeView?.metrics || {};
    const failedCount = Number(payload?.positionRuntimeDispatchFailedCount || 0);
    const criticalValidation = Number(runtimeMetrics?.staleValidation || 0);
    const digestStatuses = new Set([
      'autonomous_action_queued',
      'autonomous_action_retrying',
      'autonomous_action_blocked_by_safety',
    ]);
    if (digestStatuses.has(autonomousActionStatus) && failedCount === 0 && criticalValidation === 0) {
      return {
        ...base,
        alarmType: 'report',
        visibility: 'digest',
        actionability: 'none',
      };
    }
  }

  return base;
}

function loadRecentLocalProbeTrend() {
  try {
    if (!fs.existsSync(LOCAL_LLM_HEALTH_HISTORY_FILE)) {
      return { status: 'unknown', okCount: 0, failCount: 0, transitionCount: 0, lastError: null, latest: null };
    }

    const recent = String(fs.readFileSync(LOCAL_LLM_HEALTH_HISTORY_FILE, 'utf8') || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-6)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    if (recent.length === 0) {
      return { status: 'unknown', okCount: 0, failCount: 0, transitionCount: 0, lastError: null, latest: null };
    }

    let transitionCount = 0;
    for (let i = 1; i < recent.length; i += 1) {
      if (Boolean(recent[i - 1]?.probeOk) !== Boolean(recent[i]?.probeOk)) transitionCount += 1;
    }

    const okCount = recent.filter((row) => row?.probeOk).length;
    const failCount = recent.filter((row) => row && !row.probeOk).length;
    const latest = recent[recent.length - 1] || null;
    const lastError = recent.slice().reverse().find((row) => row && !row.probeOk)?.probeError || null;

    let status = 'stable';
    if (recent.length < 2) status = 'warming_up';
    else if (failCount > 0 && transitionCount >= 2) status = 'flapping';
    else if (latest && !latest.probeOk) status = 'degraded';

    return { status, okCount, failCount, transitionCount, lastError, latest };
  } catch (error) {
    return {
      status: 'unknown',
      okCount: 0,
      failCount: 0,
      transitionCount: 0,
      lastError: error?.message || String(error),
      latest: null,
    };
  }
}

function getLocalStandbySummary() {
  if (!LOCAL_STANDBY_ENABLED) {
    return 'standby 비활성화됨 (Groq 우선)';
  }
  try {
    const output = execSync(`lsof -nP -iTCP:${SECONDARY_LOCAL_PORT} -sTCP:LISTEN`, { encoding: 'utf8' });
    return output.trim() ? `standby 준비됨 (127.0.0.1:${SECONDARY_LOCAL_PORT})` : `standby 없음 (127.0.0.1:${SECONDARY_LOCAL_PORT})`;
  } catch {
    return `standby 없음 (127.0.0.1:${SECONDARY_LOCAL_PORT})`;
  }
}

function truncateText(value, max = 280) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function parseJsonTail(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // tail scan fallback
  }

  const starts = [];
  for (let i = raw.length - 1; i >= 0; i -= 1) {
    if (raw[i] !== '{') continue;
    starts.push(i);
    if (starts.length >= 80) break;
  }
  for (const index of starts) {
    try {
      return JSON.parse(raw.slice(index));
    } catch {
      // keep scanning
    }
  }
  return null;
}

function runMcpHealthProbe(probe = null) {
  const command = String(probe?.command || '').trim();
  const label = String(probe?.label || 'unknown');
  const startedAt = Date.now();
  if (!command) {
    return {
      ok: false,
      label,
      command,
      latencyMs: Date.now() - startedAt,
      error: 'missing_probe_command',
      payload: null,
      stdoutTail: '',
      stderrTail: '',
    };
  }

  try {
    const stdout = execSync(command, {
      encoding: 'utf8',
      timeout: MCP_HEALTH_CHECK_TIMEOUT_MS,
      maxBuffer: 2 * 1024 * 1024,
    });
    const payload = parseJsonTail(stdout);
    const status = String(payload?.status || '').trim().toLowerCase();
    const ok = status === 'ok';
    return {
      ok,
      label,
      command,
      latencyMs: Date.now() - startedAt,
      status: status || 'unknown',
      error: ok ? null : (payload?.message || `status_${status || 'unknown'}`),
      payload,
      stdoutTail: truncateText(stdout, 360),
      stderrTail: '',
    };
  } catch (error) {
    const stdout = String(error?.stdout || '');
    const stderr = String(error?.stderr || '');
    const payload = parseJsonTail(stdout) || parseJsonTail(stderr);
    const status = String(payload?.status || '').trim().toLowerCase() || null;
    const message = payload?.message
      || truncateText(stderr, 360)
      || truncateText(stdout, 360)
      || truncateText(error?.message || String(error), 360)
      || 'mcp_health_probe_failed';
    return {
      ok: false,
      label,
      command,
      latencyMs: Date.now() - startedAt,
      status,
      error: message,
      payload,
      stdoutTail: truncateText(stdout, 360),
      stderrTail: truncateText(stderr, 360),
    };
  }
}

// ─── launchctl 파싱 ──────────────────────────────────────────────

function getLaunchctlStatus() {
  const raw = execSync('launchctl list', { encoding: 'utf-8' });
  const services = {};
  for (const line of raw.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const [pid, exitCode, label] = parts;
    services[label] = {
      loaded: true,
      running: pid !== '-',
      pid: pid !== '-' ? parseInt(pid) : null,
      exitCode: parseInt(exitCode) || 0,
    };
  }

  for (const label of ALL_SERVICES) {
    services[label] = {
      ...(services[label] || { loaded: false, running: false, pid: null, exitCode: null }),
      ...getLaunchctlServiceDebug(label),
    };
  }
  return services;
}

function extractLaunchctlPath(printText = '', field = 'stdout') {
  const match = String(printText || '').match(new RegExp(`\\b${field} path\\s*=\\s*(.+)$`, 'm'));
  return match ? String(match[1]).trim() : null;
}

function readLogTail(filePath = null, maxLines = 8, maxChars = 360) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const text = String(fs.readFileSync(filePath, 'utf8') || '').trim();
    if (!text) return null;
    return truncateText(text.split(/\r?\n/).slice(-maxLines).join('\n'), maxChars);
  } catch {
    return null;
  }
}

function getLaunchctlServiceDebug(label) {
  try {
    const printResult = runLaunchctl(['print', `${launchdDomain()}/${label}`], { timeout: 5_000 });
    const printText = [printResult.stdout, printResult.stderr].filter(Boolean).join('\n');
    const missingService = /Could not find service/i.test(printText);
    const stdoutPath = extractLaunchctlPath(printText, 'stdout');
    const stderrPath = extractLaunchctlPath(printText, 'stderr');
    const lastExitMatch = printText.match(/\blast exit code\s*=\s*(-?\d+)/i);
    return {
      loaded: !missingService,
      lastExitCode: lastExitMatch ? Number(lastExitMatch[1]) : null,
      stdoutPath,
      stderrPath,
      stdoutTail: readLogTail(stdoutPath),
      stderrTail: readLogTail(stderrPath),
      launchctlDetail: truncateText(printText, 360),
    };
  } catch {
    return {
      loaded: null,
      lastExitCode: null,
      stdoutPath: null,
      stderrPath: null,
      stdoutTail: null,
      stderrTail: null,
      launchctlDetail: null,
    };
  }
}

function classifyServiceExitIssue(svc = {}) {
  const text = [
    svc.stderrTail || '',
    svc.stdoutTail || '',
    svc.launchctlDetail || '',
  ].join('\n').toLowerCase();
  if (
    text.includes('empty_screening_result') ||
    text.includes('유동성 필터 통과 후보 없음') ||
    text.includes('스크리닝 실패') ||
    (text.includes('bridge 실패') && text.includes('direct fallback'))
  ) {
    return {
      level: 1,
      title: '실행 경고',
      reason: 'screening_or_bridge_fallback',
    };
  }
  return {
    level: null,
    title: '비정상 종료',
    reason: 'runtime_error',
  };
}

// ─── 메인 ───────────────────────────────────────────────────────

async function main() {
  console.log(`[루나 헬스체크] 시작 — ${new Date().toISOString()}`);

  let status;
  try {
    status = getLaunchctlStatus();
  } catch (e) {
    console.error(`[루나 헬스체크] launchctl 실행 실패: ${e.message}`);
    process.exit(1);
  }

  const state    = hsm.loadState();
  const issues   = [];
  const recovers = [];

  for (const label of ALL_SERVICES) {
    const svc       = status[label];
    const shortName = hsm.shortLabel(label);
    const ownership = getServiceOwnership(label);
    if (isRetiredService(label)) {
      hsm.clearAlert(state, `unloaded:${label}`);
      hsm.clearAlert(state, `down:${label}`);
      Object.keys(state)
        .filter((key) => key.startsWith(`exitcode:${label}:`))
        .forEach((key) => hsm.clearAlert(state, key));
      continue;
    }

    // 1. 미로드 감지
    if (!svc || svc.loaded === false) {
      if (isElixirOwnedService(label) || isRetiredService(label)) {
        hsm.clearAlert(state, `unloaded:${label}`);
        continue;
      }

      const key = `unloaded:${label}`;
      if (hsm.canAlert(state, key)) {
        const ownerHint = ownership?.owner === 'launchd' ? '' : `\nownership=${ownership?.owner || 'unknown'}`;
        issues.push({ key, level: hsm.getAlertLevel(label), msg: `🔴 [투자팀 루나 헬스] ${shortName} 미로드\nlaunchd에 등록되지 않음 → 수동 확인 필요${ownerHint}` });
      }
      continue;
    }

    // 미로드 → 회복
    if (state[`unloaded:${label}`]) {
      recovers.push({ key: `unloaded:${label}`, msg: `✅ [투자팀 루나 헬스] ${shortName} 회복\nlaunchd 정상 로드 — 자동 감지` });
      hsm.clearAlert(state, `unloaded:${label}`);
    }

    // 2. 상시 서비스 다운 감지
    if (CONTINUOUS.includes(label)) {
      if (!svc.running) {
        const key = `down:${label}`;
        if (hsm.canAlert(state, key)) {
          issues.push({ key, level: hsm.getAlertLevel(label), msg: `🔴 [투자팀 루나 헬스] ${shortName} 다운\nPID 없음 — launchd 재시작 실패 가능성` });
        }
      } else if (state[`down:${label}`]) {
        recovers.push({ key: `down:${label}`, msg: `✅ [투자팀 루나 헬스] ${shortName} 회복\nPID 정상 확인 — 자동 감지` });
        hsm.clearAlert(state, `down:${label}`);
      }
    }

    // 3. 비정상 종료 코드 감지
    if (!NORMAL_EXIT_CODES.has(svc.exitCode) && !(CONTINUOUS.includes(label) && svc.running)) {
      const key = `exitcode:${label}:${svc.exitCode}`;
      if (hsm.canAlert(state, key)) {
        const exitIssue = classifyServiceExitIssue(svc);
        const detailLines = [
          svc.stderrTail ? `stderr: ${svc.stderrTail}` : '',
          !svc.stderrTail && svc.stdoutTail ? `stdout: ${svc.stdoutTail}` : '',
          svc.launchctlDetail ? `launchctl: ${svc.launchctlDetail}` : '',
        ].filter(Boolean);
        issues.push({
          key,
          level: exitIssue.level ?? hsm.getAlertLevel(label),
          meta: {
            exitCode: svc.exitCode,
            exitClassification: exitIssue.reason,
            lastExitCode: svc.lastExitCode ?? null,
            stdoutPath: svc.stdoutPath || null,
            stderrPath: svc.stderrPath || null,
            stdoutTail: svc.stdoutTail || null,
            stderrTail: svc.stderrTail || null,
            launchctlDetail: svc.launchctlDetail || null,
          },
          msg: `⚠️ [투자팀 루나 헬스] ${shortName} ${exitIssue.title}\nexit code: ${svc.exitCode}${detailLines.length ? `\n${detailLines.join('\n')}` : ''}`,
        });
      }
    } else {
      const prevKeys = Object.keys(state).filter(k => k.startsWith(`exitcode:${label}:`));
      if (prevKeys.length > 0) {
        recovers.push({ key: `exitcode:${label}:0`, msg: `✅ [투자팀 루나 헬스] ${shortName} 회복\nexit code 정상 (0) — 자동 감지` });
        prevKeys.forEach(k => hsm.clearAlert(state, k));
      }
    }
  }

  try {
    for (const probe of MCP_HEALTH_PROBES) {
      const result = runMcpHealthProbe(probe);
      if (!result.ok) {
        if (hsm.canAlert(state, probe.key)) {
          issues.push({
            key: probe.key,
            level: 2,
            meta: {
              autonomousActionStatus: 'autonomous_action_blocked_by_safety',
              provider: probe.label,
              command: probe.command,
              nextCommand: probe.nextCommand,
              latencyMs: result.latencyMs,
              status: result.status || 'error',
              error: result.error || null,
              payload: result.payload || null,
              stdoutTail: result.stdoutTail || null,
              stderrTail: result.stderrTail || null,
            },
            msg: `⚠️ [투자팀 루나 헬스] ${probe.label} MCP health 실패\naction status: autonomous_action_blocked_by_safety\nreason: ${result.error || 'unknown'}\nlatency: ${result.latencyMs}ms\nnext command: ${probe.nextCommand}`,
          });
        }
      } else if (state[probe.key]) {
        recovers.push({
          key: probe.key,
          msg: `✅ [투자팀 루나 헬스] ${probe.label} MCP health 회복\nstatus=${result.status || 'ok'} / latency ${result.latencyMs}ms — 자동 감지`,
        });
        hsm.clearAlert(state, probe.key);
      }
    }
  } catch (e) {
    const key = 'mcp-health-check-failed';
    if (hsm.canAlert(state, key)) {
      issues.push({
        key,
        level: 1,
        msg: `ℹ️ [투자팀 루나 헬스] MCP health 점검 실패\n${e.message}`,
      });
    }
  }

  try {
    const validation = await validateTradeReview({ days: 90, fix: false });
    if (validation.findings > 0) {
      const key = 'trade-review-integrity';
      if (hsm.canAlert(state, key)) {
        const summary = validation.summary || {};
        const scope = summary.paperOnly
          ? `paper-only (live ${summary.liveFindings || 0} / paper ${summary.paperFindings || 0})`
          : `live ${summary.liveFindings || 0} / paper ${summary.paperFindings || 0}`;
        const repairCommand = summary.repairCommand
          ? `\nrepair: ${summary.repairCommand}`
          : '';
        issues.push({
          key,
          level: 2,
          msg: `⚠️ [투자팀 루나 헬스] trade_review 정합성 이상\n종료 거래 ${validation.closedTrades}건 중 ${validation.findings}건 점검 필요\nscope: ${scope}\nissue: ${summary.topIssue?.key || 'unknown'}${repairCommand}`,
        });
      }
    } else if (state['trade-review-integrity']) {
      recovers.push({ key: 'trade-review-integrity', msg: `✅ [투자팀 루나 헬스] trade_review 정합성 회복\n거래 리뷰 누락/불일치 없음 — 자동 감지` });
      hsm.clearAlert(state, 'trade-review-integrity');
    }
  } catch (e) {
    const key = 'trade-review-check-failed';
    if (hsm.canAlert(state, key)) {
      issues.push({
        key,
        level: 2,
        msg: `⚠️ [투자팀 루나 헬스] trade_review 점검 실패\n${e.message}`,
      });
    }
  }

  try {
    const incidentAudit = await backfillTradeIncidentLinks({
      dryRun: true,
      json: true,
      onlyFamilyBias: false,
      limit: 500,
    });
    const missing = Number(incidentAudit?.updated || 0);
    const key = 'trade-incident-link-integrity';
    if (missing > 0) {
      if (hsm.canAlert(state, key)) {
        const sample = incidentAudit.samples?.[0] || null;
        issues.push({
          key,
          level: 2,
          msg: `⚠️ [투자팀 루나 헬스] trade incident link 누락 후보\n복구 후보 ${missing}건${sample ? `\nsample: ${sample.exchange}/${sample.symbol} ${sample.tradeId}` : ''}\nnext command: npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run journal:backfill-incident-links -- --dry-run --json`,
        });
      }
    } else if (state[key]) {
      recovers.push({
        key,
        msg: '✅ [투자팀 루나 헬스] trade incident link 정합성 회복\nsignals/trades와 journal incident link 누락 후보 없음 — 자동 감지',
      });
      hsm.clearAlert(state, key);
    }
  } catch (e) {
    const key = 'trade-incident-link-check-failed';
    if (hsm.canAlert(state, key)) {
      issues.push({
        key,
        level: 1,
        msg: `ℹ️ [투자팀 루나 헬스] trade incident link 점검 실패\n${e.message}`,
      });
    }
  }

  try {
    const learningLoop = await buildRuntimeLearningLoopReport({ days: 14, json: true });
    if (
      learningLoop?.decision?.status === 'regime_strategy_tuning_needed' ||
      learningLoop?.decision?.status === 'regime_strategy_monitor'
    ) {
      const topSuggestion = learningLoop?.sections?.strategy?.runtimeSuggestionTop || null;
      const suggestionAlreadyApplied =
        learningLoop?.decision?.status === 'regime_strategy_monitor' ||
        isAlreadyAppliedSuggestion(topSuggestion);
      const key = suggestionAlreadyApplied
        ? 'learning-loop-regime-monitor'
        : 'learning-loop-regime-tuning';
      const latestOpsSnapshot = loadLatestOpsSnapshot();
      const { weakest: latestWeakest, weakestMode: latestWeakestMode } = getWeakestRegimeSummary(
        latestOpsSnapshot?.health?.runtimeLearningLoop,
      );
      const latestSnapshotSummary = formatSnapshotSummary(latestOpsSnapshot, latestWeakest, latestWeakestMode);
      if (suggestionAlreadyApplied) {
        hsm.clearAlert(state, 'learning-loop-regime-tuning');
      }
      if (hsm.canAlert(state, key)) {
        const topSuggestionCurrent = topSuggestion?.current ?? topSuggestion?.governance?.current ?? 'n/a';
        const topSuggestionSuggested = topSuggestion?.suggestedValue ?? topSuggestion?.suggested ?? 'n/a';
        issues.push({
          key,
          level: suggestionAlreadyApplied ? 1 : 2,
          msg: `${suggestionAlreadyApplied ? 'ℹ️' : '⚠️'} [투자팀 루나 헬스] regime strategy ${suggestionAlreadyApplied ? 'monitor' : 'tuning'}\n${learningLoop.decision.headline}\nweakest: ${learningLoop?.sections?.collect?.regimePerformance?.weakestRegime?.regime || 'n/a'} / ${learningLoop?.sections?.collect?.regimePerformance?.weakestRegime?.worstMode?.tradeMode || 'n/a'}\ntop suggestion: ${topSuggestion?.key || 'n/a'} ${suggestionAlreadyApplied ? `${topSuggestionCurrent} (already applied)` : `${topSuggestionCurrent} -> ${topSuggestionSuggested}`} (${topSuggestion?.action || 'n/a'})${latestSnapshotSummary ? `\n${latestSnapshotSummary}` : ''}\nnext command: npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime-suggest -- --json`,
        });
      }
    } else if (state['learning-loop-regime-tuning'] || state['learning-loop-regime-monitor']) {
      if (state['learning-loop-regime-tuning']) {
        recovers.push({
          key: 'learning-loop-regime-tuning',
          msg: '✅ [투자팀 루나 헬스] regime strategy tuning 회복\n현재 learning loop 기준 레짐 튜닝 긴급 신호 없음 — 자동 감지',
        });
        hsm.clearAlert(state, 'learning-loop-regime-tuning');
      }
      if (state['learning-loop-regime-monitor']) {
        recovers.push({
          key: 'learning-loop-regime-monitor',
          msg: '✅ [투자팀 루나 헬스] regime strategy monitor 회복\n현재 learning loop 기준 관찰 알림 신호 없음 — 자동 감지',
        });
        hsm.clearAlert(state, 'learning-loop-regime-monitor');
      }
    }

    const strategyFeedbackOutcomes = learningLoop?.sections?.collect?.strategyFeedbackOutcomes || null;
    const strategyFeedbackKey = 'learning-loop-strategy-feedback-outcomes';
    if (strategyFeedbackOutcomes?.status === 'strategy_feedback_outcome_attention') {
      if (hsm.canAlert(state, strategyFeedbackKey)) {
        const weakest = strategyFeedbackOutcomes?.weak || strategyFeedbackOutcomes?.weakest || null;
        const trend = strategyFeedbackOutcomes?.trend || null;
        const delta = trend?.delta || {};
        issues.push({
          key: strategyFeedbackKey,
          level: 2,
          msg: `⚠️ [투자팀 루나 헬스] strategy feedback outcomes attention\n${strategyFeedbackOutcomes.headline || '전략 피드백 적용 결과 점검 필요'}\ntagged ${strategyFeedbackOutcomes.total || strategyFeedbackOutcomes.totalTagged || 0} / closed ${strategyFeedbackOutcomes.closed || strategyFeedbackOutcomes.closedTagged || 0} / pnl ${strategyFeedbackOutcomes.pnlSummary || (strategyFeedbackOutcomes.pnlNet ?? 0)}${trend ? `\ntrend: history ${trend.historyCount || 0} / tagged Δ${delta.total ?? 0} / closed Δ${delta.closed ?? 0} / pnl Δ${delta.pnlSummary ?? delta.pnlNet ?? 0}` : ''}${weakest ? `\nweakest: ${weakest.familyBias || 'n/a'} / ${weakest.family || 'n/a'} / ${weakest.executionKind || 'n/a'} avg ${weakest.avgPnlPercent ?? 'n/a'}%` : ''}\nnext command: npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:strategy-feedback-outcomes -- --json`,
        });
      }
    } else if (state[strategyFeedbackKey]) {
      recovers.push({
        key: strategyFeedbackKey,
        msg: '✅ [투자팀 루나 헬스] strategy feedback outcomes 회복\n전략 피드백 적용 결과 기준 주의 신호 없음 — 자동 감지',
      });
      hsm.clearAlert(state, strategyFeedbackKey);
    }

    const riskApproval = learningLoop?.sections?.collect?.riskApproval || null;
    const riskApprovalOutcome = riskApproval?.outcome || null;
    const riskApprovalOutcomeMode = riskApproval?.outcomeByMode?.[0] || null;
    const riskApprovalOutcomeModel = riskApproval?.outcomeByModel?.[0] || null;
    const riskApprovalOutcomeWorst = riskApproval?.outcomeSamples?.worst?.[0] || null;
    const riskApprovalReadiness = learningLoop?.sections?.collect?.riskApprovalReadiness || null;
    const riskApprovalReadinessDelta = riskApprovalReadiness?.trend?.delta || {};
    const riskApprovalModeAudit = learningLoop?.sections?.collect?.riskApprovalModeAudit || null;
    const riskApprovalModeAuditDelta = riskApprovalModeAudit?.trend?.delta || {};
    const riskApprovalOutcomeAttention =
      Number(riskApprovalOutcome?.closed || 0) >= 3 &&
      (
        Number(riskApprovalOutcome?.avgPnlPercent ?? 0) < 0 ||
        Number(riskApprovalOutcome?.pnlNet ?? 0) < 0 ||
        Number(riskApprovalOutcomeMode?.avgPnlPercent ?? 0) < 0
      );
    const riskApprovalOutcomeKey = 'learning-loop-risk-approval-outcome-attention';
    if (riskApprovalOutcomeAttention) {
      if (hsm.canAlert(state, riskApprovalOutcomeKey)) {
        issues.push({
          key: riskApprovalOutcomeKey,
          level: 2,
          msg: `⚠️ [투자팀 루나 헬스] risk approval outcome attention\naction status: autonomous_action_blocked_by_safety\n리스크 승인 체인의 사후 성과가 약해 outcome 기반 튜닝 후보를 확인해야 합니다.\nclosed ${riskApprovalOutcome.closed || 0}/${riskApprovalOutcome.total || 0} / win ${riskApprovalOutcome.winRate ?? 'n/a'}% / avg ${riskApprovalOutcome.avgPnlPercent ?? 'n/a'}% / pnl ${riskApprovalOutcome.pnlNet ?? 0}${riskApprovalOutcomeMode ? `\nmode: ${riskApprovalOutcomeMode.mode || 'n/a'} / closed ${riskApprovalOutcomeMode.closed || 0}/${riskApprovalOutcomeMode.total || 0} / avg ${riskApprovalOutcomeMode.avgPnlPercent ?? 'n/a'}% / pnl ${riskApprovalOutcomeMode.pnlNet ?? 0}` : ''}${riskApprovalOutcomeModel ? `\nmodel: ${riskApprovalOutcomeModel.model || 'n/a'} / closed ${riskApprovalOutcomeModel.closed || 0}/${riskApprovalOutcomeModel.total || 0} / avg ${riskApprovalOutcomeModel.avgPnlPercent ?? 'n/a'}% / pnl ${riskApprovalOutcomeModel.pnlNet ?? 0}` : ''}${riskApprovalOutcomeWorst ? `\nworst: ${riskApprovalOutcomeWorst.exchange || 'n/a'}/${riskApprovalOutcomeWorst.symbol || 'n/a'} ${riskApprovalOutcomeWorst.mode || 'n/a'} pnl ${riskApprovalOutcomeWorst.pnlNet ?? 'n/a'} (${riskApprovalOutcomeWorst.pnlPercent ?? 'n/a'}%) models ${(riskApprovalOutcomeWorst.models || []).join(',') || 'n/a'}` : ''}\noperator note: debug commands are available in alert payload.meta`,
        });
      }
    } else if (state[riskApprovalOutcomeKey]) {
      recovers.push({
        key: riskApprovalOutcomeKey,
        msg: '✅ [투자팀 루나 헬스] risk approval outcome 회복\n리스크 승인 사후 성과 기준 주의 신호 없음 — 자동 감지',
      });
      hsm.clearAlert(state, riskApprovalOutcomeKey);
    }

    const riskApprovalKey = 'learning-loop-risk-approval-divergence';
    if (riskApproval?.status === 'risk_approval_preview_divergence') {
      if (hsm.canAlert(state, riskApprovalKey)) {
        const topModel = riskApproval?.topModels?.[0] || null;
        const trend = riskApproval?.trend || null;
        const delta = trend?.delta || {};
        issues.push({
          key: riskApprovalKey,
          level: 2,
          msg: `⚠️ [투자팀 루나 헬스] risk approval preview divergence\naction status: autonomous_action_blocked_by_safety\n${riskApproval.headline || '리스크 승인 preview와 기존 승인 결과 차이 점검 필요'}\npreview ${riskApproval.total || 0} / rejects ${riskApproval.previewRejects || 0} / divergence ${riskApproval.divergence || 0}\namount delta ${riskApproval.previewVsApprovedDelta ?? 0}${trend ? `\ntrend: history ${trend.historyCount || 0} / preview Δ${delta.total ?? 0} / reject Δ${delta.previewRejects ?? 0} / divergence Δ${delta.legacyApprovedPreviewRejected ?? 0} / amount Δ${delta.previewVsApprovedDelta ?? 0}` : ''}${topModel ? `\ntop model: ${topModel.model || 'n/a'} / adjust ${topModel.adjust || 0} / reject ${topModel.reject || 0} / pass ${topModel.pass || 0}` : ''}\noperator note: debug commands are available in alert payload.meta`,
        });
      }
    } else if (state[riskApprovalKey]) {
      recovers.push({
        key: riskApprovalKey,
        msg: '✅ [투자팀 루나 헬스] risk approval preview 회복\n리스크 승인 preview와 기존 승인 간 divergence 없음 — 자동 감지',
      });
      hsm.clearAlert(state, riskApprovalKey);
    }

    const riskApprovalReadinessKey = 'learning-loop-risk-approval-readiness-blocked';
    if (riskApprovalReadiness?.status === 'risk_approval_readiness_blocked') {
      if (hsm.canAlert(state, riskApprovalReadinessKey)) {
        issues.push({
          key: riskApprovalReadinessKey,
          level: 2,
          msg: `⚠️ [투자팀 루나 헬스] risk approval mode readiness\naction status: autonomous_action_blocked_by_safety\n${riskApprovalReadiness.headline || '리스크 승인 체인 전환 blocker 점검 필요'}\nmode ${riskApprovalReadiness.currentMode || 'n/a'} -> ${riskApprovalReadiness.targetMode || 'n/a'}\nblockers: ${(riskApprovalReadiness.blockers || []).join(' / ') || 'n/a'}\ntrend: history ${riskApprovalReadiness.trend?.historyCount || 0} / blocker Δ${riskApprovalReadinessDelta.blockerCount ?? 0} / preview Δ${riskApprovalReadinessDelta.previewTotal ?? 0} / reject Δ${riskApprovalReadinessDelta.previewRejects ?? 0} / divergence Δ${riskApprovalReadinessDelta.divergence ?? 0}${riskApprovalReadiness.dryRun ? `\ndry-run assist: applied ${riskApprovalReadiness.dryRun.assist?.applied ?? 0} / rejected ${riskApprovalReadiness.dryRun.assist?.rejected ?? 0} / amount delta ${riskApprovalReadiness.dryRun.assist?.amountDelta ?? 0}\ndry-run enforce: applied ${riskApprovalReadiness.dryRun.enforce?.applied ?? 0} / rejected ${riskApprovalReadiness.dryRun.enforce?.rejected ?? 0} / amount delta ${riskApprovalReadiness.dryRun.enforce?.amountDelta ?? 0}` : ''}\noperator note: debug commands are available in alert payload.meta`,
        });
      }
    } else if (state[riskApprovalReadinessKey]) {
      recovers.push({
        key: riskApprovalReadinessKey,
        msg: '✅ [투자팀 루나 헬스] risk approval mode readiness 회복\n리스크 승인 체인 전환 blocker 없음 — 자동 감지',
      });
      hsm.clearAlert(state, riskApprovalReadinessKey);
    }

    const riskApprovalCandidateKey = 'learning-loop-risk-approval-mode-candidate';
    const candidateStatuses = ['risk_approval_readiness_assist_ready', 'risk_approval_readiness_enforce_candidate'];
    if (candidateStatuses.includes(riskApprovalReadiness?.status)) {
      if (hsm.canAlert(state, riskApprovalCandidateKey)) {
        issues.push({
          key: riskApprovalCandidateKey,
          level: 1,
        msg: `ℹ️ [투자팀 루나 헬스] risk approval mode candidate\naction status: autonomous_action_queued\n${riskApprovalReadiness.headline || '리스크 승인 체인 mode 전환 후보'}\nmode ${riskApprovalReadiness.currentMode || 'n/a'} -> ${riskApprovalReadiness.targetMode || 'n/a'}\ntrend: history ${riskApprovalReadiness.trend?.historyCount || 0} / blocker Δ${riskApprovalReadinessDelta.blockerCount ?? 0} / preview Δ${riskApprovalReadinessDelta.previewTotal ?? 0}\n자동 전환 없이 governance/마스터 승인 후보로만 기록합니다.\noperator note: debug commands are available in alert payload.meta`,
        });
      }
    } else if (state[riskApprovalCandidateKey]) {
      recovers.push({
        key: riskApprovalCandidateKey,
        msg: '✅ [투자팀 루나 헬스] risk approval mode candidate 종료\n현재는 리스크 승인 체인 mode 전환 후보 상태가 아닙니다 — 자동 감지',
      });
      hsm.clearAlert(state, riskApprovalCandidateKey);
    }

    const riskApprovalModeAuditKey = 'learning-loop-risk-approval-mode-audit';
    if (['risk_approval_mode_audit_attention', 'risk_approval_mode_audit_mode_watch'].includes(riskApprovalModeAudit?.status)) {
      if (hsm.canAlert(state, riskApprovalModeAuditKey)) {
        issues.push({
          key: riskApprovalModeAuditKey,
          level: riskApprovalModeAudit.status === 'risk_approval_mode_audit_attention' ? 2 : 1,
          msg: `⚠️ [투자팀 루나 헬스] risk approval mode audit\naction status: autonomous_action_blocked_by_safety\n${riskApprovalModeAudit.headline || '리스크 승인 mode/readiness 적용 상태 점검'}\nmode ${riskApprovalModeAudit.metrics?.currentMode || 'n/a'} / readiness ${riskApprovalModeAudit.metrics?.readinessStatus || 'n/a'} / blockers ${riskApprovalModeAudit.metrics?.blockerCount || 0}\napplication applied ${riskApprovalModeAudit.metrics?.applied || 0} / rejected ${riskApprovalModeAudit.metrics?.rejected || 0} / non-shadow ${riskApprovalModeAudit.metrics?.nonShadowApplications || 0}\noutcome closed ${riskApprovalModeAudit.metrics?.outcomeClosed || 0} / pnl ${riskApprovalModeAudit.metrics?.outcomePnlNet ?? 0} / avg ${riskApprovalModeAudit.metrics?.outcomeAvgPnlPercent ?? 'n/a'}%\ntrend: history ${riskApprovalModeAudit.trend?.historyCount || 0} / non-shadow Δ${riskApprovalModeAuditDelta.nonShadowApplications ?? 0} / unavailable Δ${riskApprovalModeAuditDelta.unavailablePreviewCount ?? 0} / blocker Δ${riskApprovalModeAuditDelta.blockerCount ?? 0} / outcome pnl Δ${riskApprovalModeAuditDelta.outcomePnlNet ?? 0}\noperator note: debug commands are available in alert payload.meta`,
        });
      }
    } else if (state[riskApprovalModeAuditKey]) {
      recovers.push({
        key: riskApprovalModeAuditKey,
        msg: '✅ [투자팀 루나 헬스] risk approval mode audit 회복\nmode/readiness/application 충돌 없음 — 자동 감지',
      });
      hsm.clearAlert(state, riskApprovalModeAuditKey);
    }
  } catch (e) {
    const key = 'learning-loop-check-failed';
    if (hsm.canAlert(state, key)) {
      issues.push({
        key,
        level: 2,
        msg: `⚠️ [투자팀 루나 헬스] learning loop 점검 실패\n${e.message}`,
      });
    }
  }

  try {
    const collectionAudit = await runCollectionAudit({ markets: ['binance', 'kis', 'kis_overseas'], hours: 24 });
    const insufficient = collectionAudit?.markets?.find((item) => item?.collectQuality?.status === 'insufficient') || null;
    const degraded = collectionAudit?.markets?.find((item) => item?.collectQuality?.status === 'degraded') || null;

    if (insufficient || degraded) {
      const target = insufficient || degraded;
      const key = insufficient ? 'collection-audit-insufficient' : 'collection-audit-degraded';
      const level = insufficient ? 2 : 1;
      if (insufficient) hsm.clearAlert(state, 'collection-audit-degraded');
      if (hsm.canAlert(state, key)) {
        const remediation = target.remediation || {};
        const commandLines = [
          remediation.commands?.research ? `research: ${remediation.commands.research}` : null,
          remediation.commands?.maintenance ? `maintenance: ${remediation.commands.maintenance}` : null,
          remediation.commands?.audit ? `audit: ${remediation.commands.audit}` : null,
        ].filter(Boolean).join('\n');
        issues.push({
          key,
          level,
          msg: `${insufficient ? '⚠️' : 'ℹ️'} [투자팀 루나 헬스] collection audit ${insufficient ? 'attention' : 'monitor'}\nmarket: ${target.market}\ncollect quality: ${target.collectQuality?.status || 'unknown'}\nreason: ${remediation.reason || (target.collectQuality?.reasons || []).join(', ') || 'n/a'}\nscreening: ${target.screeningUniverseCount} / maintenance: ${target.maintenanceUniverseCount} / profiled: ${target.maintenanceProfiledCount} / dust skipped: ${target.dustSkippedCount}${commandLines ? `\nnext commands:\n${commandLines}` : '\nnext command: npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:collection-audit'}`,
        });
      }
    } else if (state['collection-audit-insufficient'] || state['collection-audit-degraded']) {
      if (state['collection-audit-insufficient']) {
        recovers.push({
          key: 'collection-audit-insufficient',
          msg: '✅ [투자팀 루나 헬스] collection audit 회복\ncollect quality insufficient market 없음 — 자동 감지',
        });
        hsm.clearAlert(state, 'collection-audit-insufficient');
      }
      if (state['collection-audit-degraded']) {
        recovers.push({
          key: 'collection-audit-degraded',
          msg: '✅ [투자팀 루나 헬스] collection audit 안정화\ncollect quality degraded market 없음 — 자동 감지',
        });
        hsm.clearAlert(state, 'collection-audit-degraded');
      }
    }
  } catch (e) {
    const key = 'collection-audit-check-failed';
    if (hsm.canAlert(state, key)) {
      issues.push({
        key,
        level: 1,
        msg: `ℹ️ [투자팀 루나 헬스] collection audit 점검 실패\n${e.message}`,
      });
    }
  }

  try {
    const hygiene = await runPositionStrategyHygiene({ json: true });
    const remediation = await runPositionStrategyRemediation({
      json: true,
      autonomousApply: true,
      stableCycles: 3,
    }).catch(() => null);
    const remediationHistory = remediation?.remediationHistory || null;
    const key = 'position-strategy-remediation';
    const legacyKey = 'position-strategy-hygiene';
    if (hygiene?.decision?.status === 'position_strategy_hygiene_attention') {
      if (hsm.canAlert(state, key)) {
        const duplicateSample = hygiene?.duplicateNormalization?.rows?.[0] || null;
        const orphanSample = hygiene?.orphanRetirement?.rows?.[0] || null;
        const remediationView = buildHealthCheckRemediationView(remediation, hygiene, remediationHistory);
        const remediationPlan = remediationView.remediationPlan;
        const remediationFlat = remediationView.remediationFlat;
        const remediationSummary = remediationView.remediationSummary;
        const remediationStatus = remediationView.remediationStatus;
        const remediationHeadline = remediationView.remediationHeadline;
        const remediationCounts = remediationView.remediationCounts;
        const remediationDuplicateManaged = remediationView.remediationDuplicateManaged;
        const remediationOrphanProfiles = remediationView.remediationOrphanProfiles;
        const remediationUnmatchedManaged = remediationView.remediationUnmatchedManaged;
        const remediationCommands = remediationView.remediationCommands;
        const remediationActions = remediationView.remediationActions;
        const remediationRefreshState = remediationView.remediationRefreshState;
        const remediationRefreshNeeded = remediationView.remediationRefreshNeeded;
        const remediationRefreshStale = remediationView.remediationRefreshStale;
        const remediationRefreshReason = remediationView.remediationRefreshReason;
        const remediationRefreshCommand = remediationView.remediationRefreshCommand;
        const remediationRefreshHint = remediationView.remediationObservationHint || remediationRefreshReason || null;
        const remediationTrend = remediationView.remediationTrend;
        const remediationNextCommand = remediationView.remediationNextCommand;
        const remediationNextCommandTransition = remediationView.remediationNextCommandTransition;
        const remediationNextCommandChanged = remediationView.remediationNextCommandChanged;
        const remediationNextCommandPrevious = remediationView.remediationNextCommandPrevious;
        const remediationNextCommandCurrent = remediationView.remediationNextCommandCurrent;
        const recommendedExchange = remediationView.recommendedExchange;
        let remediationHistoryLine = null;
        if (remediationTrend) {
          const historyCount = remediationView.remediationTrendHistoryCount ?? 0;
          const changed = remediationView.remediationTrendChanged;
          const nextChanged = remediationView.remediationTrendNextChanged ?? remediationNextCommandChanged;
          const nextPrevious = remediationNextCommandPrevious || 'none';
          const nextCurrent = remediationNextCommandCurrent || 'none';
          const ageMinutes = remediationView.remediationTrendAgeMinutes ?? 'n/a';
          const stale = remediationView.remediationTrendStale;
          const duplicateDelta = remediationView.remediationTrendDuplicateDelta ?? 0;
          const orphanDelta = remediationView.remediationTrendOrphanDelta ?? 0;
          remediationHistoryLine = `remediation history: count ${historyCount} / changed ${changed ? 'yes' : 'no'} / next changed ${nextChanged ? 'yes' : 'no'}${nextChanged ? ` (${nextPrevious} -> ${nextCurrent})` : ''} / age ${ageMinutes}m / stale ${stale ? 'yes' : 'no'} / duplicate delta ${duplicateDelta >= 0 ? '+' : ''}${duplicateDelta} / orphan delta ${orphanDelta >= 0 ? '+' : ''}${orphanDelta}`;
        } else if (remediationHistory) {
          remediationHistoryLine = `remediation history: count ${remediationHistory.historyCount || 0} / changed ${remediationHistory.statusChanged ? 'yes' : 'no'} / next changed ${remediationHistory.nextCommandChanged ? 'yes' : 'no'}${remediationHistory.nextCommandChanged ? ` (${remediationHistory.nextCommandTransition?.previous || 'none'} -> ${remediationHistory.nextCommandTransition?.current || 'none'})` : ''} / age ${remediationHistory.ageMinutes ?? 'n/a'}m / stale ${remediationHistory.stale ? 'yes' : 'no'} / duplicate delta ${remediationHistory.delta?.duplicateManaged >= 0 ? '+' : ''}${remediationHistory.delta?.duplicateManaged || 0} / orphan delta ${remediationHistory.delta?.orphanProfiles >= 0 ? '+' : ''}${remediationHistory.delta?.orphanProfiles || 0}`;
        }
        const remediationAlertLevel = remediationRefreshStale
          ? 2
          : ((remediationView.remediationAutonomousContext?.stableEnough === true && remediationView.remediationAutonomousContext?.safeEnough === false)
            ? 1
            : (Number(hygiene?.audit?.duplicateManagedProfileScopes || 0) > 0 || Number(hygiene?.audit?.unmatchedManagedPositions || 0) > 0 ? 2 : 1));
        issues.push({
          key,
          level: remediationAlertLevel,
          meta: {
            remediationFlat,
            remediationSummary,
            remediationStatus,
            remediationHeadline,
            remediationCounts,
            remediationDuplicateManaged,
            remediationOrphanProfiles,
            remediationUnmatchedManaged,
            remediationRefreshState,
            remediationRefreshNeeded,
            remediationRefreshStale,
            remediationRefreshReason,
            remediationRefreshCommand,
            remediationHistory: remediationHistory || null,
            remediationTrend,
            remediationTrendHistoryCount: remediationView.remediationTrendHistoryCount,
            remediationTrendChanged: remediationView.remediationTrendChanged,
            remediationTrendNextChanged: remediationView.remediationTrendNextChanged,
            remediationTrendAgeMinutes: remediationView.remediationTrendAgeMinutes,
            remediationTrendStale: remediationView.remediationTrendStale,
            remediationTrendDuplicateDelta: remediationView.remediationTrendDuplicateDelta,
            remediationTrendOrphanDelta: remediationView.remediationTrendOrphanDelta,
            remediationTrendUnmatchedDelta: remediationView.remediationTrendUnmatchedDelta,
            remediationNextCommand,
            remediationNextCommandTransition,
            remediationNextCommandChanged,
            remediationNextCommandPrevious,
            remediationNextCommandCurrent,
            remediationCommands,
            remediationActionReportCommand: remediationView.remediationActionReportCommand,
            remediationActionAutonomousApplyCommand: remediationView.remediationActionAutonomousApplyCommand,
            remediationActionHistoryCommand: remediationView.remediationActionHistoryCommand,
            remediationActionRefreshCommand: remediationView.remediationActionRefreshCommand,
            remediationActionHygieneCommand: remediationView.remediationActionHygieneCommand,
            remediationActionNormalizeDryRunCommand: remediationView.remediationActionNormalizeDryRunCommand,
            remediationActionNormalizeApplyCommand: remediationView.remediationActionNormalizeApplyCommand,
            remediationActionRetireDryRunCommand: remediationView.remediationActionRetireDryRunCommand,
            remediationActionRetireApplyCommand: remediationView.remediationActionRetireApplyCommand,
            remediationReportCommand: remediationView.remediationReportCommand,
            remediationAutonomousApplyCommand: remediationView.remediationActionAutonomousApplyCommand || remediationView.remediationCommands?.autonomousApply || null,
            remediationHistoryCommand: remediationView.remediationHistoryCommand,
            remediationRefreshCommand,
            remediationNormalizeDryRunCommand: remediationView.remediationNormalizeDryRunCommand,
            remediationNormalizeApplyCommand: remediationView.remediationNormalizeApplyCommand,
            remediationRetireDryRunCommand: remediationView.remediationRetireDryRunCommand,
            remediationRetireApplyCommand: remediationView.remediationRetireApplyCommand,
            remediationRecommendedExchange: remediation?.remediationRecommendedExchange || recommendedExchange,
            recommendedExchange,
            remediationPlan,
            remediationActions,
            remediationAutonomousStatus: remediationView.remediationAutonomousStatus,
            remediationAutonomousReason: remediationView.remediationAutonomousReason,
            remediationAutonomousContext: remediationView.remediationAutonomousContext || null,
            remediationObservationHint: remediationView.remediationObservationHint || null,
            remediationAutonomousVerify: remediation?.remediationAutonomousVerify || null,
          },
          msg: `⚠️ [투자팀 루나 헬스] position strategy remediation\n${remediationHeadline}\naction status: ${remediationView.remediationAutonomousStatus}${remediationView.remediationAutonomousReason ? ` (${remediationView.remediationAutonomousReason})` : ''}\nduplicate managed scopes ${remediationDuplicateManaged} / orphan profiles ${remediationOrphanProfiles} / unmatched managed ${remediationUnmatchedManaged}${remediationHistoryLine ? `\n${remediationHistoryLine}` : ''}${remediationRefreshHint ? `\n${remediationRefreshHint}` : ''}${recommendedExchange ? `\nrecommended exchange: ${recommendedExchange}` : ''}${duplicateSample ? `\nduplicate sample: ${duplicateSample.exchange}/${duplicateSample.symbol} keeper=${duplicateSample.keeperProfileId} retirements=${duplicateSample.retirements?.length || 0}` : ''}${orphanSample ? `\norphan sample: ${orphanSample.exchange}/${orphanSample.symbol} ${orphanSample.tradeMode} ${orphanSample.lifecycleStatus}` : ''}\noperator note: debug commands are available in alert payload.meta`,
        });
      }
    } else if (state[key] || state[legacyKey]) {
      recovers.push({
        key,
        msg: '✅ [투자팀 루나 헬스] position strategy remediation 회복\nmanaged 포지션 기준 duplicate/orphan/unmatched 이슈 없음 — 자동 감지',
      });
      hsm.clearAlert(state, key);
      hsm.clearAlert(state, legacyKey);
    }
  } catch (e) {
    const key = 'position-strategy-remediation-check-failed';
    if (hsm.canAlert(state, key)) {
      issues.push({
        key,
        level: 1,
        msg: `ℹ️ [투자팀 루나 헬스] position strategy remediation 점검 실패\n${e.message}`,
      });
    }
  }

  try {
    const runtimeReport = await runPositionRuntimeReport({ json: true, limit: 200 });
    const runtimeTuning = await runPositionRuntimeTuning({ json: true }).catch(() => null);
    const runtimeDispatch = await runPositionRuntimeDispatch({ json: true, limit: 20 }).catch(() => null);
    const runtimeView = buildHealthCheckRuntimeView(runtimeReport, runtimeTuning, runtimeDispatch);
    const key = 'position-runtime-loop';
    const active = Number(runtimeView.metrics?.active || 0);
    const adjustReady = Number(runtimeView.metrics?.adjustReady || 0);
    const exitReady = Number(runtimeView.metrics?.exitReady || 0);
    const criticalValidation = Number(runtimeView.metrics?.staleValidation || 0);
    const topCandidate = runtimeView.dispatchTopCandidate || null;
    const topSuggestion = runtimeView.tuningSuggestion || null;
    const shouldAlert = exitReady > 0 || adjustReady > 0 || criticalValidation > 0 || runtimeView.tuningStatus === 'position_runtime_tuning_attention';
    if (shouldAlert) {
      if (hsm.canAlert(state, key)) {
        issues.push({
          key,
          level: exitReady > 0 || criticalValidation > 0 ? 2 : 1,
          meta: {
            positionRuntimeView: runtimeView,
            positionRuntimeStatus: runtimeView.status,
            positionRuntimeHeadline: runtimeView.headline,
            positionRuntimeMetrics: runtimeView.metrics,
            positionRuntimeTuningStatus: runtimeView.tuningStatus,
            positionRuntimeTuningSuggestion: runtimeView.tuningSuggestion,
            positionRuntimeDispatchStatus: runtimeView.dispatchStatus,
            positionRuntimeDispatchCandidates: runtimeView.dispatchCandidates,
            positionRuntimeDispatchTopCandidate: runtimeView.dispatchTopCandidate,
            positionRuntimeDispatchQueuedCount: runtimeView.dispatchQueuedCount,
            positionRuntimeDispatchRetryingCount: runtimeView.dispatchRetryingCount,
            positionRuntimeDispatchFailedCount: runtimeView.dispatchFailedCount,
            positionRuntimeDispatchExecutedCount: runtimeView.dispatchExecutedCount,
            positionRuntimeAutonomousActionStatus: runtimeView.autonomousActionStatus,
            positionRuntimeMarketQueue: runtimeView.marketQueue,
            positionRuntimeReportCommand: runtimeView.reportCommand,
            positionRuntimeTuningCommand: runtimeView.tuningCommand,
            positionRuntimeDispatchCommand: runtimeView.dispatchCommand,
            positionRuntimeAutotuneCommand: runtimeView.autotuneCommand,
            positionRuntimeAutopilotCommand: runtimeView.autopilotCommand,
          },
          msg: `⚠️ [투자팀 루나 헬스] position runtime loop\n${runtimeView.headline}\naction status: ${runtimeView.autonomousActionStatus || 'autonomous_action_blocked_by_safety'}\nactive ${active} / fast-lane ${runtimeView.metrics?.fastLane || 0} / adjust ${adjustReady} / exit ${exitReady} / critical validation ${criticalValidation}\ntuning ${runtimeView.tuningStatus}${topSuggestion ? ` / ${topSuggestion.exchange} ${topSuggestion.status} ${topSuggestion.currentAverageCadenceMs || 'n/a'} -> ${topSuggestion.recommendedCadenceMs || 'n/a'}` : ''}\ndispatch ${runtimeView.dispatchStatus} / candidates ${runtimeView.dispatchCandidates}${topCandidate ? ` / top ${topCandidate.exchange}/${topCandidate.symbol} ${topCandidate.action} ${topCandidate.urgency}` : ''}\nqueue waiting ${runtimeView.marketQueue?.waitingMarketOpen || 0} / retrying ${runtimeView.marketQueue?.retrying || 0}${runtimeView.marketQueueWaitingSample ? `\nwaiting sample: ${runtimeView.marketQueueWaitingSample}` : ''}${runtimeView.marketQueueRetrySample ? `\nretry sample: ${runtimeView.marketQueueRetrySample}` : ''}\noperator note: debug commands are available in alert payload.meta`,
        });
      }
    } else if (state[key]) {
      recovers.push({
        key,
        msg: '✅ [투자팀 루나 헬스] position runtime loop 안정화\nruntime adjust/exit/critical validation attention 없음 — 자동 감지',
      });
      hsm.clearAlert(state, key);
    }
  } catch (e) {
    const key = 'position-runtime-loop-check-failed';
    if (hsm.canAlert(state, key)) {
      issues.push({
        key,
        level: 1,
        msg: `ℹ️ [투자팀 루나 헬스] position runtime loop 점검 실패\n${e.message}`,
      });
    }
  }

  try {
    const executionGuard = await loadExecutionRiskApprovalGuardHealth(pgPool, 24);
    const key = 'execution-risk-approval-guard';
    if (Number(executionGuard?.total || 0) > 0) {
      if (hsm.canAlert(state, key)) {
        const top = executionGuard.rows?.[0] || null;
        const sample = executionGuard.samples?.[0] || null;
        issues.push({
          key,
          level: Number(executionGuard.staleCount || 0) > 0 ? 2 : 1,
          meta: {
            autonomousActionStatus: 'autonomous_action_blocked_by_safety',
            reportCommand: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run report',
            executionGuard,
          },
          msg: `⚠️ [투자팀 루나 헬스] execution risk approval guard\naction status: autonomous_action_blocked_by_safety\n최근 ${executionGuard.periodHours}시간 실행 직전 차단 ${executionGuard.total}건\nstale ${executionGuard.staleCount} / bypass ${executionGuard.bypassCount}${top ? `\ntop: ${top.exchange} ${top.blockCode} ${top.count}건 (${top.blockedBy})` : ''}${sample ? `\nsample: ${sample.exchange}/${sample.symbol} ${sample.blockCode}` : ''}\noperator note: debug commands are available in alert payload.meta`,
        });
      }
    } else if (state[key]) {
      recovers.push({
        key,
        msg: '✅ [투자팀 루나 헬스] execution risk approval guard 회복\n최근 24시간 실행 직전 리스크 승인 차단 없음 — 자동 감지',
      });
      hsm.clearAlert(state, key);
    }
  } catch (e) {
    const key = 'execution-risk-approval-guard-check-failed';
    if (hsm.canAlert(state, key)) {
      issues.push({
        key,
        level: 1,
        msg: `ℹ️ [투자팀 루나 헬스] execution risk approval guard 점검 실패\n${e.message}`,
      });
    }
  }

  hsm.clearAlert(state, 'local-llm-standby-missing');

  const localLlmTrend = loadRecentLocalProbeTrend();
  if (localLlmTrend.status === 'flapping') {
    const key = 'local-llm-flapping';
    if (hsm.canAlert(state, key)) {
      issues.push({
        key,
        level: 3,
        msg: `⚠️ [투자팀 루나 헬스] local LLM flapping\n최근 probe ok ${localLlmTrend.okCount} / fail ${localLlmTrend.failCount} / 전환 ${localLlmTrend.transitionCount}회\n11434는 embeddings 전용이며, chat 경로는 Groq 우선${localLlmTrend.lastError ? `\nlast error: ${localLlmTrend.lastError}` : ''}`,
      });
    }
  } else if (localLlmTrend.status === 'degraded') {
    const key = 'local-llm-degraded';
    if (hsm.canAlert(state, key)) {
      issues.push({
        key,
        level: 2,
        msg: `⚠️ [투자팀 루나 헬스] local LLM degraded\n최근 embeddings probe 실패\n11434는 embeddings 전용이며, chat 경로는 Groq 우선${localLlmTrend.lastError ? `\n${localLlmTrend.lastError}` : ''}`,
      });
    }
  } else {
    ['local-llm-flapping', 'local-llm-degraded'].forEach((key) => {
      if (state[key]) {
        recovers.push({ key, msg: `✅ [투자팀 루나 헬스] local LLM 회복\n최근 생성 probe 기준 ${localLlmTrend.status} 상태 — 자동 감지` });
        hsm.clearAlert(state, key);
      }
    });
  }

  // 이슈 알림 발송
  for (const { key, level, msg, meta } of issues) {
    console.warn(`[루나 헬스체크] 이슈: ${msg}`);
    const memoryHints = await buildIssueHints(key, msg);
    await notify(`${msg}${memoryHints}`, level, {
      issueKey: key,
      ...(meta && typeof meta === 'object' ? meta : {}),
    });
    await rememberHealthEvent(key, 'issue', msg, level, meta);
    hsm.recordAlert(state, key);
  }

  // 회복 알림 발송
  for (const { key, msg } of recovers) {
    await notify(msg, 1, { issueKey: key, recovery: true });
    await rememberHealthEvent(key, 'recovery', msg, 1);
  }

  hsm.saveState(state);

  if (issues.length === 0) {
    console.log(`[루나 헬스체크] 정상 — 전체 ${ALL_SERVICES.length}개 서비스 이상 없음`);
  }
}

main().catch(e => {
  console.error(`[루나 헬스체크] 예외: ${e.message}`);
  process.exit(1);
});
