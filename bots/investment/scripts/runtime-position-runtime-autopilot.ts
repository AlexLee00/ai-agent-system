#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runPositionRuntimeReport } from './runtime-position-runtime-report.ts';
import { runPositionRuntimeTuning } from './runtime-position-runtime-tuning.ts';
import { runPositionRuntimeDispatch } from './runtime-position-runtime-dispatch.ts';
import { runPositionRuntimeAutotune } from './runtime-position-runtime-autotune.ts';
import { assessPhase6SafetyReadiness } from '../shared/position-closeout-engine.ts';
import { refreshPositionSignals } from '../shared/position-signal-refresh.ts';
import { syncPositionsAtMarketOpen } from '../shared/position-sync.ts';
import { resolvePositionLifecycleFlags } from '../shared/position-lifecycle-flags.ts';
import {
  buildLifecycleExecutionReadiness,
  summarizeLifecyclePositionSync,
} from '../shared/position-lifecycle-operational-readiness.ts';
import {
  appendPositionRuntimeAutopilotHistory,
  DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
  readPositionRuntimeAutopilotHistorySummary,
} from './runtime-position-runtime-autopilot-history-store.ts';

function parseArgs(argv = []) {
  const args = {
    exchange: null,
    execute: false,
    limit: 5,
    json: false,
    confirm: null,
    applyTuning: false,
    executeDispatch: false,
    historyFile: DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
    recordHistory: true,
    requirePositionSync: false,
    positionSyncMarkets: ['crypto'],
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--execute') args.execute = true;
    else if (raw === '--apply-tuning') args.applyTuning = true;
    else if (raw === '--execute-dispatch') args.executeDispatch = true;
    else if (raw.startsWith('--exchange=')) args.exchange = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--confirm=')) args.confirm = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--limit=')) args.limit = Math.max(1, Number(raw.split('=').slice(1).join('=') || 5));
    else if (raw.startsWith('--history-file=')) args.historyFile = raw.split('=').slice(1).join('=') || DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE;
    else if (raw === '--no-history') args.recordHistory = false;
    else if (raw === '--require-position-sync') args.requirePositionSync = true;
    else if (raw.startsWith('--position-sync-markets=')) {
      const rawMarkets = raw.split('=').slice(1).join('=') || 'crypto';
      args.positionSyncMarkets = rawMarkets.split(',').map((item) => item.trim()).filter(Boolean);
    }
  }
  return args;
}

function buildCadenceRecommendationByExchange(tuning = null) {
  const summary = {};
  for (const item of tuning?.suggestions || []) {
    if (!item?.exchange) continue;
    summary[item.exchange] = {
      status: item.status || null,
      recommendedCadenceMs: item.recommendedCadenceMs ?? null,
      currentAverageCadenceMs: item.currentAverageCadenceMs ?? null,
      reason: item.reason || null,
    };
  }
  return summary;
}

function buildCadenceAppliedByExchange(autotuneResult = null) {
  const summary = {};
  for (const item of autotuneResult?.appliedSuggestions || []) {
    const exchanges = Array.isArray(item?.exchanges) && item.exchanges.length > 0
      ? item.exchanges
      : String(item?.exchange || '').split(',').filter(Boolean);
    for (const exchange of exchanges) {
      summary[exchange] = {
        key: item.key || null,
        appliedCadenceMs: Number.isFinite(Number(item?.recommendedCadenceMs))
          ? Number(item.recommendedCadenceMs)
          : null,
        previousCadenceMs: Number.isFinite(Number(item?.currentAverageCadenceMs))
          ? Number(item.currentAverageCadenceMs)
          : null,
        status: item.status || null,
      };
    }
  }
  return summary;
}

function buildDecision(runtimeReport, tuning, dispatch, autotune, phase6SafetyReadiness = null) {
  const metrics = runtimeReport?.decision?.metrics || {};
  const dispatchCandidates = Array.isArray(dispatch?.candidates) ? dispatch.candidates.length : 0;
  const blockedActionable = Number(dispatch?.guardReasonSummary?.blockedActionable || 0);
  const executeDispatch = dispatchCandidates > 0;
  const applyTuning = tuning?.status === 'position_runtime_tuning_attention';
  const blockedByGuard = executeDispatch === false
    && blockedActionable > 0
    && (Number(metrics.exitReady || 0) > 0 || Number(metrics.adjustReady || 0) > 0);
  const blockedBySafety = phase6SafetyReadiness?.ok === false;
  const topGuardReasons = (dispatch?.guardReasonSummary?.topReasons || [])
    .slice(0, 2)
    .map((item) => `${item.reason}(${item.count})`);
  const marketQueue = dispatch?.marketQueue || {};
  const queuedWaiting = Number(marketQueue.waitingMarketOpen || 0);
  const queuedRetrying = Number(marketQueue.retrying || 0);
  const cadenceRecommendations = buildCadenceRecommendationByExchange(tuning);
  return {
    status: blockedBySafety
      ? 'position_runtime_autopilot_blocked'
      : executeDispatch || applyTuning
        ? 'position_runtime_autopilot_ready'
        : blockedByGuard
          ? 'position_runtime_autopilot_blocked'
          : 'position_runtime_autopilot_idle',
    headline: `runtime active ${metrics.active || 0} / adjust ${metrics.adjustReady || 0} / exit ${metrics.exitReady || 0} / tuning ${tuning?.status || 'unknown'} / dispatch ${dispatch?.status || 'unknown'} / phase6-safety ${phase6SafetyReadiness?.ok === true ? 'ok' : 'blocked'}`,
    executeDispatch,
    applyTuning,
    blockedByGuard,
    blockedBySafety,
    cadenceRecommendations,
    nextActions: [
      applyTuning ? 'runtime autotune apply candidate present' : null,
      executeDispatch ? 'runtime dispatch candidate present' : null,
      blockedByGuard
        ? `dispatch blocked by guard (${topGuardReasons.join(', ') || 'execution_allowed_false'})`
        : null,
      blockedBySafety
        ? `phase6 safety contracts failed (${(phase6SafetyReadiness?.checks || []).filter((item) => item?.ok !== true).map((item) => item.key).join(', ') || 'unknown'})`
        : null,
      queuedWaiting > 0 ? `market-open queue waiting ${queuedWaiting}` : null,
      queuedRetrying > 0 ? `market-open queue retrying ${queuedRetrying}` : null,
    ].filter(Boolean),
    commands: {
      report: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime -- --json',
      tuning: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-tuning -- --json',
      autotune: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-autotune -- --apply --confirm=runtime-autotune --json',
      dispatch: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-dispatch -- --execute --phase6 --confirm=phase6-autopilot --json',
    },
  };
}

function renderText(result = {}) {
  const lines = [
    '🤖 Position Runtime Autopilot',
    `status: ${result.decision?.status || 'unknown'}`,
    `headline: ${result.decision?.headline || 'n/a'}`,
  ];
  if (result.phase6SafetyReadiness?.ok === false) {
    const failedChecks = (result.phase6SafetyReadiness?.checks || []).filter((item) => item?.ok !== true);
    lines.push(`phase6 safety blocked: ${failedChecks.map((item) => item.key).join(', ') || 'unknown'}`);
  }
  for (const item of result.decision?.nextActions || []) lines.push(`- ${item}`);
  return lines.join('\n');
}

function buildExchangeRuntimeSummary(rows = []) {
  return (rows || []).reduce((acc, row) => {
    const exchange = row?.exchange || 'unknown';
    if (!acc[exchange]) {
      acc[exchange] = {
        active: 0,
        fastLane: 0,
        adjustReady: 0,
        exitReady: 0,
        staleValidation: 0,
      };
    }
    if (!row?.runtimeState) return acc;
    const bucket = acc[exchange];
    bucket.active += 1;
    const cadenceMs = Number(row?.runtimeState?.monitoringPolicy?.cadenceMs || 0);
    if (cadenceMs > 0 && cadenceMs <= 15_000) bucket.fastLane += 1;
    if (row?.runtimeState?.executionIntent?.action === 'ADJUST') bucket.adjustReady += 1;
    if (row?.runtimeState?.executionIntent?.action === 'EXIT') bucket.exitReady += 1;
    if (row?.runtimeState?.validationState?.severity === 'critical') bucket.staleValidation += 1;
    return acc;
  }, {});
}

function buildDispatchExchangeSummary(candidates = [], results = []) {
  const summary = {};
  for (const candidate of candidates || []) {
    const exchange = candidate?.exchange || 'unknown';
    if (!summary[exchange]) {
      summary[exchange] = { candidates: 0, executed: 0 };
    }
    summary[exchange].candidates += 1;
  }
  for (const result of results || []) {
    const exchange = result?.candidate?.exchange || 'unknown';
    if (!summary[exchange]) {
      summary[exchange] = { candidates: 0, executed: 0 };
    }
    if (String(result?.autonomousActionStatus || '') === 'autonomous_action_executed') {
      summary[exchange].executed += 1;
    }
  }
  return summary;
}

function buildHistorySnapshot({
  args,
  decision,
  lifecycleReadiness,
  signalRefresh,
  positionSyncSummary,
  phase6SafetyReadiness,
  runtimeReport,
  tuning,
  dispatchPreview,
  autotunePreview,
  autotuneResult,
  dispatchResult,
  status,
}) {
  const metrics = runtimeReport?.decision?.metrics || {};
  const exchangeSummary = buildExchangeRuntimeSummary(runtimeReport?.rows || []);
  const dispatchSummary = buildDispatchExchangeSummary(dispatchPreview?.candidates || [], dispatchResult?.results || []);
  const dispatchFailures = (dispatchResult?.results || []).filter((item) => item?.autonomousActionStatus === 'autonomous_action_failed');
  const dispatchQueued = (dispatchResult?.results || []).filter((item) => item?.autonomousActionStatus === 'autonomous_action_queued').length;
  const dispatchRetrying = (dispatchResult?.results || []).filter((item) => item?.autonomousActionStatus === 'autonomous_action_retrying').length;
  const dispatchExecuted = (dispatchResult?.results || []).filter((item) => item?.autonomousActionStatus === 'autonomous_action_executed').length;
  const dispatchSkipped = (dispatchResult?.results || []).filter((item) => String(item?.autonomousActionStatus || '').startsWith('autonomous_action_skipped')).length;
  const cadenceRecommendationByExchange = buildCadenceRecommendationByExchange(tuning);
  const cadenceAppliedByExchange = buildCadenceAppliedByExchange(autotuneResult);
  return {
    recordedAt: new Date().toISOString(),
    exchange: args.exchange || 'all',
    status: status || decision?.status || 'unknown',
    headline: decision?.headline || null,
    executed: Boolean(args.execute),
    requested: {
      applyTuning: Boolean(args.applyTuning),
      executeDispatch: Boolean(args.executeDispatch),
    },
    decision: {
      executeDispatch: Boolean(decision?.executeDispatch),
      applyTuning: Boolean(decision?.applyTuning),
      nextActions: decision?.nextActions || [],
    },
    lifecycleReadiness: lifecycleReadiness || null,
    signalRefresh: signalRefresh ? {
      ok: signalRefresh.ok !== false,
      enabled: signalRefresh.enabled === true,
      count: Number(signalRefresh.count || 0),
    } : null,
    positionSyncSummary: positionSyncSummary || null,
    metrics: {
      active: Number(metrics.active || 0),
      fastLane: Number(metrics.fastLane || 0),
      adjustReady: Number(metrics.adjustReady || 0),
      exitReady: Number(metrics.exitReady || 0),
      staleValidation: Number(metrics.staleValidation || 0),
      pyramidReady: Number(metrics.pyramidReady || 0),
      dynamicTrailExitReady: Number(metrics.dynamicTrailExitReady || 0),
      signalRefreshActive: Number(metrics.signalRefreshActive || 0),
    },
    exchangeSummary,
    tuningStatus: tuning?.status || null,
    tuningSuggestions: (tuning?.suggestions || []).map((item) => ({
      exchange: item.exchange,
      status: item.status,
      recommendedCadenceMs: item.recommendedCadenceMs ?? null,
      currentAverageCadenceMs: item.currentAverageCadenceMs ?? null,
      pressureScore: item.pressureScore ?? null,
      reason: item.reason || null,
    })),
    dispatchCandidateCount: Array.isArray(dispatchPreview?.candidates) ? dispatchPreview.candidates.length : 0,
    dispatchExecutedCount: dispatchExecuted,
    dispatchSkippedCount: dispatchSkipped,
    dispatchQueuedCount: dispatchQueued,
    dispatchRetryingCount: dispatchRetrying,
    dispatchFailureCount: dispatchFailures.length,
    dispatchSkipped: (dispatchResult?.results || [])
      .filter((item) => String(item?.autonomousActionStatus || '').startsWith('autonomous_action_skipped'))
      .slice(0, 5)
      .map((item) => ({
        exchange: item?.candidate?.exchange || null,
        symbol: item?.candidate?.symbol || null,
        tradeMode: item?.candidate?.tradeMode || null,
        status: item?.status || 'skipped',
      })),
    dispatchFailures: dispatchFailures.slice(0, 5).map((item) => ({
      exchange: item?.candidate?.exchange || null,
      symbol: item?.candidate?.symbol || null,
      tradeMode: item?.candidate?.tradeMode || null,
      status: item?.status || 'failed',
    })),
    dispatchByExchange: dispatchSummary,
    dispatchGuardReasonSummary: dispatchPreview?.guardReasonSummary || null,
    dispatchMarketQueue: dispatchResult?.marketQueue || dispatchPreview?.marketQueue || null,
    dispatchBlockedCandidates: (dispatchPreview?.blockedCandidates || []).slice(0, 5).map((item) => ({
      exchange: item.exchange,
      symbol: item.symbol,
      action: item.action,
      sourceQualityBlocked: item.sourceQualityBlocked === true,
      validationSeverity: item.validationSeverity || 'stable',
      executionAllowed: item.executionAllowed === true,
      guardReasons: item.guardReasons || [],
    })),
    autotuneStatus: autotunePreview?.status || null,
    autotuneApplied: autotuneResult?.status === 'position_runtime_autotune_applied',
    appliedUpdates: autotuneResult?.updates || null,
    cadenceRecommendationByExchange,
    cadenceAppliedByExchange,
    phase6SafetyReadiness: phase6SafetyReadiness || null,
  };
}

async function runPositionSyncPreflight(markets = ['crypto']) {
  const uniqueMarkets = [...new Set((markets || ['crypto']).map((item) => String(item || '').trim()).filter(Boolean))];
  const results = await Promise.all(uniqueMarkets.map(async (market) => (
    syncPositionsAtMarketOpen(market).catch((error) => ({
      market,
      ok: false,
      error: error?.message || String(error),
    }))
  )));
  return summarizeLifecyclePositionSync(results);
}

export async function runPositionRuntimeAutopilot(args = {}) {
  const lifecycleFlags = resolvePositionLifecycleFlags();
  const phase6SafetyReadiness = args.phase6SafetyReadiness || assessPhase6SafetyReadiness();
  const requirePositionSync = args.requirePositionSync === true
    || String(process.env.LUNA_POSITION_LIFECYCLE_REQUIRE_SYNC || '').trim() === '1'
    || (lifecycleFlags.autonomous && String(process.env.LUNA_POSITION_LIFECYCLE_SKIP_SYNC_PREFLIGHT || '').trim() !== '1');
  const positionSyncSummary = args.execute && requirePositionSync
    ? await runPositionSyncPreflight(args.positionSyncMarkets || ['crypto'])
    : null;
  const signalRefresh = await refreshPositionSignals({
    exchange: args.exchange || null,
    source: 'position_runtime_autopilot',
    limit: 200,
  }).catch((error) => ({
    ok: false,
    enabled: true,
    count: 0,
    error: error?.message || String(error),
  }));
  const runtimeReport = await runPositionRuntimeReport({ exchange: args.exchange || null, limit: 200, json: true });
  const tuning = await runPositionRuntimeTuning({ exchange: args.exchange || null, json: true });
  const dispatchPreview = await runPositionRuntimeDispatch({ exchange: args.exchange || null, limit: args.limit || 5, phase6: true, json: true });
  const autotunePreview = await runPositionRuntimeAutotune({ exchange: args.exchange || null, json: true });
  const decision = buildDecision(runtimeReport, tuning, dispatchPreview, autotunePreview, phase6SafetyReadiness);
  const lifecycleReadiness = buildLifecycleExecutionReadiness({
    flags: lifecycleFlags,
    runtimeReport,
    dispatchPreview,
    signalRefresh,
    positionSyncSummary,
    requirePositionSync,
  });

  if (!args.execute) {
    const previewPayload = {
      ok: true,
      decision,
      lifecycleReadiness,
      signalRefresh,
      positionSyncSummary,
      phase6SafetyReadiness,
      runtimeReport,
      tuning,
      dispatchPreview,
      autotunePreview,
    };
    const historySnapshot = buildHistorySnapshot({
      args,
      decision,
      lifecycleReadiness,
      signalRefresh,
      positionSyncSummary,
      phase6SafetyReadiness,
      runtimeReport,
      tuning,
      dispatchPreview,
      autotunePreview,
      status: decision.status,
    });
    if (args.recordHistory !== false) {
      appendPositionRuntimeAutopilotHistory(historySnapshot, args.historyFile || DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE);
    }
    const history = readPositionRuntimeAutopilotHistorySummary(args.historyFile || DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE);
    return {
      ...previewPayload,
      historyFile: args.historyFile || DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
      history,
    };
  }

  if (args.confirm !== 'position-runtime-autopilot') {
    return {
      ok: false,
      status: 'position_runtime_autopilot_confirmation_required',
      decision,
      lifecycleReadiness,
      signalRefresh,
      positionSyncSummary,
      phase6SafetyReadiness,
      reason: 'use --confirm=position-runtime-autopilot',
    };
  }

  if (phase6SafetyReadiness.ok !== true) {
    return {
      ok: false,
      status: 'position_runtime_autopilot_blocked_by_phase6_safety',
      decision,
      lifecycleReadiness,
      signalRefresh,
      positionSyncSummary,
      phase6SafetyReadiness,
      reason: 'phase6 safety readiness failed; fix runtime guards before execute/apply',
    };
  }

  if (lifecycleReadiness.ok !== true) {
    return {
      ok: false,
      status: 'position_runtime_autopilot_blocked_by_lifecycle_readiness',
      decision,
      lifecycleReadiness,
      signalRefresh,
      positionSyncSummary,
      phase6SafetyReadiness,
      reason: lifecycleReadiness.blockers.join(', ') || 'lifecycle readiness blocked',
    };
  }

  const autotuneResult = args.applyTuning && decision.applyTuning
    ? await runPositionRuntimeAutotune({
      exchange: args.exchange || null,
      apply: true,
      confirm: 'runtime-autotune',
      json: true,
    })
    : null;
  const dispatchResult = args.executeDispatch && decision.executeDispatch
    ? await runPositionRuntimeDispatch({
      exchange: args.exchange || null,
      phase6: true,
      execute: true,
      confirm: 'phase6-autopilot',
      limit: args.limit || 5,
      json: true,
    })
    : null;
  const dispatchFailures = (dispatchResult?.results || []).filter((item) => item?.autonomousActionStatus === 'autonomous_action_failed');
  const dispatchQueued = (dispatchResult?.results || []).filter((item) => item?.autonomousActionStatus === 'autonomous_action_queued').length;
  const dispatchRetrying = (dispatchResult?.results || []).filter((item) => item?.autonomousActionStatus === 'autonomous_action_retrying').length;
  const executionStatus = dispatchFailures.length > 0
    ? 'position_runtime_autopilot_executed_with_dispatch_failures'
    : dispatchQueued > 0
      ? 'position_runtime_autopilot_executed_with_market_queue'
      : dispatchRetrying > 0
        ? 'position_runtime_autopilot_executed_with_retries'
        : 'position_runtime_autopilot_executed';

  const historySnapshot = buildHistorySnapshot({
    args,
    decision,
    lifecycleReadiness,
    signalRefresh,
    positionSyncSummary,
    phase6SafetyReadiness,
    runtimeReport,
    tuning,
    dispatchPreview,
    autotunePreview,
    autotuneResult,
    dispatchResult,
    status: executionStatus,
  });
  if (args.recordHistory !== false) {
    appendPositionRuntimeAutopilotHistory(historySnapshot, args.historyFile || DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE);
  }
  const history = readPositionRuntimeAutopilotHistorySummary(args.historyFile || DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE);

  return {
    ok: dispatchFailures.length === 0,
    status: executionStatus,
    decision,
    lifecycleReadiness,
    signalRefresh,
    positionSyncSummary,
    phase6SafetyReadiness,
    runtimeReport,
    tuning,
    dispatchPreview,
    autotunePreview,
    autotuneResult,
    dispatchResult,
    dispatchFailures,
    historyFile: args.historyFile || DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE,
    history,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPositionRuntimeAutopilot(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: main,
    errorPrefix: '❌ runtime-position-runtime-autopilot 오류:',
  });
}
