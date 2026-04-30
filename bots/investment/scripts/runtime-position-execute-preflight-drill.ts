#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runPositionRuntimeAutopilot } from './runtime-position-runtime-autopilot.ts';
import { runPositionRuntimeDispatch } from './runtime-position-runtime-dispatch.ts';
import { buildRuntimePositionStrategyAudit } from './runtime-position-strategy-audit.ts';
import {
  buildExecutePreflightDrill,
  buildPositionSyncFinalGate,
  normalizeMarketList,
} from '../shared/luna-l5-operational-gate.ts';
import { buildPartialAdjustRunnerPreflightForDispatchCandidate } from './partial-adjust-runner.ts';
import { buildStrategyExitRunnerPreflightForDispatchCandidate } from './strategy-exit-runner.ts';

function parseArgs(argv = []) {
  const args = {
    exchange: null,
    json: false,
    limit: 5,
    requirePositionSync: false,
    markets: ['domestic', 'overseas', 'crypto'],
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--require-position-sync') args.requirePositionSync = true;
    else if (raw.startsWith('--exchange=')) args.exchange = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--limit=')) args.limit = Math.max(1, Number(raw.split('=').slice(1).join('=') || 5));
    else if (raw.startsWith('--markets=')) args.markets = normalizeMarketList(raw.split('=').slice(1).join('=') || 'all');
  }
  return args;
}

function buildOrphanCandidateFilter(positionStrategyAudit = null) {
  const orphanKeys = new Set((positionStrategyAudit?.orphanSymbols || [])
    .map((item) => `${item.exchange || ''}:${item.symbol || ''}:${item.tradeMode || 'normal'}`));
  if (orphanKeys.size === 0) return { filtered: null, excluded: [] };
  return {
    filter(dispatchPreview = {}) {
      const candidates = Array.isArray(dispatchPreview?.candidates) ? dispatchPreview.candidates : [];
      const excluded = [];
      const kept = candidates.filter((candidate) => {
        const key = `${candidate?.exchange || ''}:${candidate?.symbol || ''}:${candidate?.tradeMode || 'normal'}`;
        if (!orphanKeys.has(key)) return true;
        excluded.push(candidate);
        return false;
      });
      return {
        filtered: {
          ...dispatchPreview,
          candidates: kept,
        },
        excluded,
      };
    },
  };
}

function uniq(items = []) {
  return [...new Set((items || []).filter(Boolean))];
}

export function isPolicyDeferredRunnerPreflight(item = {}) {
  if (item?.ok === true) return false;
  if (['partial_adjust_candidate_not_found', 'strategy_exit_candidate_not_found'].includes(item?.code)) return true;
  if (item?.code === 'partial_adjust_balance_locked_by_open_sell_orders') return true;
  if (item?.code !== 'strategy_exit_guard_blocked') return false;
  return item?.candidate?.executionGuard?.level === 'guarded';
}

async function buildRunnerPreflightChecks(candidates = []) {
  const checks = [];
  for (const candidate of candidates || []) {
    if (candidate?.runner === 'runtime:partial-adjust' && candidate?.exchange === 'binance') {
      const preflight = await buildPartialAdjustRunnerPreflightForDispatchCandidate(candidate).catch((error) => ({
        ok: false,
        code: 'partial_adjust_runner_preflight_failed',
        lines: [`- partial-adjust runner preflight failed: ${error?.message || String(error)}`],
      }));
      checks.push({
        runner: candidate.runner,
        exchange: candidate.exchange,
        symbol: candidate.symbol,
        tradeMode: candidate.tradeMode || 'normal',
        ok: preflight.ok === true,
        code: preflight.code || (preflight.ok ? 'runner_preflight_clear' : 'runner_preflight_blocked'),
        lines: preflight.lines || [],
        candidate: preflight.candidate || null,
      });
    }
    if (candidate?.runner === 'runtime:strategy-exit') {
      const preflight = await buildStrategyExitRunnerPreflightForDispatchCandidate(candidate).catch((error) => ({
        ok: false,
        code: 'strategy_exit_runner_preflight_failed',
        lines: [`- strategy-exit runner preflight failed: ${error?.message || String(error)}`],
      }));
      checks.push({
        runner: candidate.runner,
        exchange: candidate.exchange,
        symbol: candidate.symbol,
        tradeMode: candidate.tradeMode || 'normal',
        ok: preflight.ok === true,
        code: preflight.code || (preflight.ok ? 'runner_preflight_clear' : 'runner_preflight_blocked'),
        lines: preflight.lines || [],
        candidate: preflight.candidate || null,
      });
    }
  }
  return checks;
}

export function applyRunnerPreflightChecks(drill = {}, runnerPreflightChecks = []) {
  const blocked = (runnerPreflightChecks || []).filter((item) => item.ok !== true);
  const deferred = blocked.filter(isPolicyDeferredRunnerPreflight);
  const hardBlocked = blocked.filter((item) => !isPolicyDeferredRunnerPreflight(item));
  const deferredWarnings = deferred.map((item) => `runner_preflight_deferred:${item.runner}:${item.exchange}:${item.symbol}:${item.code}`);

  if (hardBlocked.length === 0) {
    return {
      ...drill,
      warnings: uniq([...(drill.warnings || []), ...deferredWarnings]),
      policyDeferredRunnerPreflightChecks: deferred,
      runnerPreflightChecks,
    };
  }
  const blockers = [
    ...(drill.blockers || []),
    ...hardBlocked.map((item) => `runner_preflight_blocked:${item.runner}:${item.exchange}:${item.symbol}:${item.code}`),
  ];
  return {
    ...drill,
    ok: false,
    status: 'execute_preflight_drill_blocked',
    blockers: uniq(blockers),
    warnings: uniq([...(drill.warnings || []), ...deferredWarnings]),
    policyDeferredRunnerPreflightChecks: deferred,
    runnerPreflightChecks,
  };
}

export async function runPositionExecutePreflightDrill(args = {}) {
  const markets = normalizeMarketList(args.markets || ['domestic', 'overseas', 'crypto']);
  const [autopilotPreview, dispatchPreviewRaw, positionStrategyAudit] = await Promise.all([
    runPositionRuntimeAutopilot({
      exchange: args.exchange || null,
      limit: args.limit || 5,
      json: true,
      recordHistory: false,
      requirePositionSync: args.requirePositionSync === true,
      runSyncPreflight: args.requirePositionSync === true,
      positionSyncMarkets: markets,
    }),
    runPositionRuntimeDispatch({
      exchange: args.exchange || null,
      limit: args.limit || 5,
      phase6: true,
      json: true,
    }),
    buildRuntimePositionStrategyAudit({
      exchange: args.exchange || null,
      json: true,
    }).catch((error) => ({
      ok: false,
      status: 'position_strategy_audit_failed',
      orphanProfiles: 1,
      orphanSymbols: [],
      error: error?.message || String(error),
    })),
  ]);
  const orphanFilter = buildOrphanCandidateFilter(positionStrategyAudit);
  const filteredDispatch = orphanFilter.filter
    ? orphanFilter.filter(dispatchPreviewRaw)
    : { filtered: dispatchPreviewRaw, excluded: [] };
  const dispatchPreview = filteredDispatch.filtered;
  const excludedOrphanCandidates = filteredDispatch.excluded || [];

  const positionSyncGate = args.requirePositionSync
    ? buildPositionSyncFinalGate({
      syncSummary: autopilotPreview.positionSyncSummary || null,
      requiredMarkets: markets,
    })
    : null;
  const runnerPreflightChecks = await buildRunnerPreflightChecks(dispatchPreview?.candidates || []);
  const drill = applyRunnerPreflightChecks(buildExecutePreflightDrill({
    autopilotPreview,
    dispatchPreview,
    lifecycleReadiness: autopilotPreview.lifecycleReadiness || null,
    positionSyncGate,
    positionStrategyAudit,
    excludedOrphanCandidates,
  }), runnerPreflightChecks);
  return {
    ok: drill.ok,
    status: drill.status,
    drill,
    lifecycleReadiness: autopilotPreview.lifecycleReadiness || null,
    signalRefresh: autopilotPreview.signalRefresh ? {
      ok: autopilotPreview.signalRefresh.ok !== false,
      enabled: autopilotPreview.signalRefresh.enabled === true,
      count: Number(autopilotPreview.signalRefresh.count || 0),
    } : null,
    positionSyncGate,
    positionStrategyAudit: {
      ok: positionStrategyAudit?.ok !== false,
      orphanProfiles: Number(positionStrategyAudit?.orphanProfiles || 0),
      dustProfiles: Number(positionStrategyAudit?.dustProfiles || 0),
      duplicateManagedProfileScopes: Number(positionStrategyAudit?.duplicateManagedProfileScopes || 0),
      unmatchedManagedPositions: Number(positionStrategyAudit?.unmatchedManagedPositions || 0),
      orphanSymbols: positionStrategyAudit?.orphanSymbols || [],
    },
    excludedOrphanCandidates,
    dispatchStatus: dispatchPreview.status,
  };
}

function renderText(result = {}) {
  return [
    '🧪 Luna execute preflight drill',
    `status: ${result.status || 'unknown'}`,
    `candidates: ${result.drill?.candidateCount ?? 0}`,
    `blockers: ${(result.drill?.blockers || []).join(' / ') || 'none'}`,
    `warnings: ${(result.drill?.warnings || []).join(' / ') || 'none'}`,
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPositionExecutePreflightDrill(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: main,
    errorPrefix: '❌ runtime-position-execute-preflight-drill 실패:',
  });
}
