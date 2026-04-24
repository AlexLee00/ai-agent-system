#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runPositionRuntimeReport } from './runtime-position-runtime-report.ts';
import { runPositionRuntimeTuning } from './runtime-position-runtime-tuning.ts';
import { runPositionRuntimeDispatch } from './runtime-position-runtime-dispatch.ts';
import { runPositionRuntimeAutotune } from './runtime-position-runtime-autotune.ts';
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

function buildDecision(runtimeReport, tuning, dispatch, autotune) {
  const metrics = runtimeReport?.decision?.metrics || {};
  const executeDispatch = Number(metrics.exitReady || 0) > 0 || Number(metrics.adjustReady || 0) > 0;
  const applyTuning = tuning?.status === 'position_runtime_tuning_attention';
  return {
    status: executeDispatch || applyTuning ? 'position_runtime_autopilot_ready' : 'position_runtime_autopilot_idle',
    headline: `runtime active ${metrics.active || 0} / adjust ${metrics.adjustReady || 0} / exit ${metrics.exitReady || 0} / tuning ${tuning?.status || 'unknown'} / dispatch ${dispatch?.status || 'unknown'}`,
    executeDispatch,
    applyTuning,
    nextActions: [
      applyTuning ? 'runtime autotune apply candidate present' : null,
      executeDispatch ? 'runtime dispatch candidate present' : null,
    ].filter(Boolean),
    commands: {
      report: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime -- --json',
      tuning: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-tuning -- --json',
      autotune: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-autotune -- --apply --confirm=runtime-autotune --json',
      dispatch: 'npm --prefix /Users/alexlee/projects/ai-agent-system/bots/investment run runtime:position-runtime-dispatch -- --execute --confirm=runtime-dispatch --json',
    },
  };
}

function renderText(result = {}) {
  const lines = [
    '🤖 Position Runtime Autopilot',
    `status: ${result.decision?.status || 'unknown'}`,
    `headline: ${result.decision?.headline || 'n/a'}`,
  ];
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
    dispatchByExchange: dispatchSummary,
    autotuneStatus: autotunePreview?.status || null,
    autotuneApplied: autotuneResult?.status === 'position_runtime_autotune_applied',
    appliedUpdates: autotuneResult?.updates || null,
  };
}

export async function runPositionRuntimeAutopilot(args = {}) {
  const runtimeReport = await runPositionRuntimeReport({ exchange: args.exchange || null, limit: 200, json: true });
  const tuning = await runPositionRuntimeTuning({ exchange: args.exchange || null, json: true });
  const dispatchPreview = await runPositionRuntimeDispatch({ exchange: args.exchange || null, limit: args.limit || 5, json: true });
  const autotunePreview = await runPositionRuntimeAutotune({ exchange: args.exchange || null, json: true });
  const decision = buildDecision(runtimeReport, tuning, dispatchPreview, autotunePreview);

  if (!args.execute) {
    const previewPayload = {
      ok: true,
      decision,
      runtimeReport,
      tuning,
      dispatchPreview,
      autotunePreview,
    };
    const historySnapshot = buildHistorySnapshot({
      args,
      decision,
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
      reason: 'use --confirm=position-runtime-autopilot',
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
      execute: true,
      confirm: 'runtime-dispatch',
      limit: args.limit || 5,
      json: true,
    })
    : null;

  const historySnapshot = buildHistorySnapshot({
    args,
    decision,
    runtimeReport,
    tuning,
    dispatchPreview,
    autotunePreview,
    autotuneResult,
    dispatchResult,
    status: 'position_runtime_autopilot_executed',
  });
  if (args.recordHistory !== false) {
    appendPositionRuntimeAutopilotHistory(historySnapshot, args.historyFile || DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE);
  }
  const history = readPositionRuntimeAutopilotHistorySummary(args.historyFile || DEFAULT_POSITION_RUNTIME_AUTOPILOT_HISTORY_FILE);

  return {
    ok: true,
    status: 'position_runtime_autopilot_executed',
    decision,
    runtimeReport,
    tuning,
    dispatchPreview,
    autotunePreview,
    autotuneResult,
    dispatchResult,
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
