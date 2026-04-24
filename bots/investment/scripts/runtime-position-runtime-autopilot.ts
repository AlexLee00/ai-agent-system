#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runPositionRuntimeReport } from './runtime-position-runtime-report.ts';
import { runPositionRuntimeTuning } from './runtime-position-runtime-tuning.ts';
import { runPositionRuntimeDispatch } from './runtime-position-runtime-dispatch.ts';
import { runPositionRuntimeAutotune } from './runtime-position-runtime-autotune.ts';
import { assessPhase6SafetyReadiness } from '../shared/position-closeout-engine.ts';
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
    if (result?.ok) summary[exchange].executed += 1;
  }
  return summary;
}

function buildHistorySnapshot({
  args,
  decision,
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
  const dispatchFailures = (dispatchResult?.results || []).filter((item) => item?.ok !== true);
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
    metrics: {
      active: Number(metrics.active || 0),
      fastLane: Number(metrics.fastLane || 0),
      adjustReady: Number(metrics.adjustReady || 0),
      exitReady: Number(metrics.exitReady || 0),
      staleValidation: Number(metrics.staleValidation || 0),
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
    dispatchExecutedCount: Array.isArray(dispatchResult?.results) ? dispatchResult.results.filter((item) => item?.ok).length : 0,
    dispatchFailureCount: dispatchFailures.length,
    dispatchFailures: dispatchFailures.slice(0, 5).map((item) => ({
      exchange: item?.candidate?.exchange || null,
      symbol: item?.candidate?.symbol || null,
      tradeMode: item?.candidate?.tradeMode || null,
      status: item?.status || 'failed',
    })),
    dispatchByExchange: dispatchSummary,
    dispatchGuardReasonSummary: dispatchPreview?.guardReasonSummary || null,
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

export async function runPositionRuntimeAutopilot(args = {}) {
  const phase6SafetyReadiness = args.phase6SafetyReadiness || assessPhase6SafetyReadiness();
  const runtimeReport = await runPositionRuntimeReport({ exchange: args.exchange || null, limit: 200, json: true });
  const tuning = await runPositionRuntimeTuning({ exchange: args.exchange || null, json: true });
  const dispatchPreview = await runPositionRuntimeDispatch({ exchange: args.exchange || null, limit: args.limit || 5, phase6: true, json: true });
  const autotunePreview = await runPositionRuntimeAutotune({ exchange: args.exchange || null, json: true });
  const decision = buildDecision(runtimeReport, tuning, dispatchPreview, autotunePreview, phase6SafetyReadiness);

  if (!args.execute) {
    const previewPayload = {
      ok: true,
      decision,
      phase6SafetyReadiness,
      runtimeReport,
      tuning,
      dispatchPreview,
      autotunePreview,
    };
    const historySnapshot = buildHistorySnapshot({
      args,
      decision,
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
      phase6SafetyReadiness,
      reason: 'use --confirm=position-runtime-autopilot',
    };
  }

  if (phase6SafetyReadiness.ok !== true) {
    return {
      ok: false,
      status: 'position_runtime_autopilot_blocked_by_phase6_safety',
      decision,
      phase6SafetyReadiness,
      reason: 'phase6 safety readiness failed; fix runtime guards before execute/apply',
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
  const dispatchFailures = (dispatchResult?.results || []).filter((item) => item?.ok !== true);
  const executionStatus = dispatchFailures.length > 0
    ? 'position_runtime_autopilot_executed_with_dispatch_failures'
    : 'position_runtime_autopilot_executed';

  const historySnapshot = buildHistorySnapshot({
    args,
    decision,
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
