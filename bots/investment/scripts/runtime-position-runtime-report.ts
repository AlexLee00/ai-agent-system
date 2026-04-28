#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = []) {
  const args = {
    exchange: null,
    symbol: null,
    json: false,
    limit: 50,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw.startsWith('--exchange=')) args.exchange = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--symbol=')) args.symbol = raw.split('=').slice(1).join('=') || null;
    else if (raw.startsWith('--limit=')) args.limit = Math.max(1, Number(raw.split('=').slice(1).join('=') || 50));
  }
  return args;
}

function buildDecision(rows = []) {
  const active = rows.filter((row) => row.runtimeState);
  const exitReady = active.filter((row) => row.runtimeState?.executionIntent?.action === 'EXIT').length;
  const adjustReady = active.filter((row) => row.runtimeState?.executionIntent?.action === 'ADJUST').length;
  const staleValidation = active.filter((row) => row.runtimeState?.validationState?.severity === 'critical').length;
  const fastLane = active.filter((row) => Number(row.runtimeState?.monitoringPolicy?.cadenceMs || 0) <= 15_000).length;
  const pyramidReady = active.filter((row) => row.runtimeState?.executionIntent?.runner === 'runtime:pyramid-adjust').length;
  const dynamicTrailExitReady = active.filter((row) => row.runtimeState?.reasonCode === 'dynamic_trail_stop_breached').length;
  const signalRefreshActive = active.filter((row) => row.runtimeState?.marketState?.signalRefreshSnapshot || row.runtimeState?.policyMatrix?.positionSignalRefresh).length;
  const status = exitReady > 0
    ? 'position_runtime_attention'
    : adjustReady > 0
      ? 'position_runtime_adjust'
      : 'position_runtime_ok';
  return {
    status,
    headline: `runtime active ${active.length} / fast-lane ${fastLane} / adjust ${adjustReady} / exit ${exitReady} / pyramid ${pyramidReady} / trail-exit ${dynamicTrailExitReady}`,
    metrics: {
      total: rows.length,
      active: active.length,
      exitReady,
      adjustReady,
      staleValidation,
      fastLane,
      pyramidReady,
      dynamicTrailExitReady,
      signalRefreshActive,
    },
  };
}

function renderText(payload = {}) {
  const lines = [
    '🧠 Position Runtime Report',
    `status: ${payload.decision?.status || 'unknown'}`,
    `headline: ${payload.decision?.headline || 'n/a'}`,
    '',
  ];
  for (const row of payload.rows || []) {
    lines.push(
      `- ${row.exchange} ${row.symbol} ${row.tradeMode} | ${row.runtimeState?.regime?.regime || 'n/a'} | ${row.runtimeState?.executionIntent?.action || 'HOLD'} | ${row.runtimeState?.monitoringPolicy?.cadenceMs || 'n/a'}ms | validity posterior ${Number(row.runtimeState?.strategyValidityScore || 0).toFixed(3)} / actionScore ${Number(row.runtimeState?.strategyValidityActionScore ?? row.runtimeState?.strategyValidityScore ?? 0).toFixed(3)} (${row.runtimeState?.strategyValidityAction || 'n/a'})`,
    );
  }
  return lines.join('\n');
}

export async function runPositionRuntimeReport(args = {}) {
  const profiles = await db.getActivePositionStrategyProfiles({
    exchange: args.exchange || null,
    symbol: args.symbol || null,
    limit: args.limit || 50,
  });
  const rows = (profiles || []).map((row) => ({
    exchange: row.exchange,
    symbol: row.symbol,
    tradeMode: row.trade_mode || 'normal',
    strategyName: row.strategy_name || null,
    setupType: row.setup_type || null,
    runtimeState: row.strategy_state?.positionRuntimeState || null,
    strategyValidityCard: row.strategy_state?.positionRuntimeState
      ? {
          score: row.strategy_state?.positionRuntimeState?.strategyValidityScore ?? null,
          actionScore: row.strategy_state?.positionRuntimeState?.strategyValidityActionScore ?? null,
          action: row.strategy_state?.positionRuntimeState?.strategyValidityAction ?? null,
        }
      : null,
    lifecycleRuntimeCard: row.strategy_state?.positionRuntimeState
      ? {
          runner: row.strategy_state?.positionRuntimeState?.executionIntent?.runner || null,
          reasonCode: row.strategy_state?.positionRuntimeState?.reasonCode || null,
          dynamicTrailBreached: row.strategy_state?.positionRuntimeState?.marketState?.trailSnapshot?.breached === true,
          positionSizingMode: row.strategy_state?.positionRuntimeState?.marketState?.positionSizingSnapshot?.mode || null,
          signalRefreshWeight: row.strategy_state?.positionRuntimeState?.marketState?.signalRefreshSnapshot?.qualityAdjustment?.reevaluationWeightMultiplier ?? null,
        }
      : null,
  }));
  const decision = buildDecision(rows);
  return {
    ok: true,
    args,
    decision,
    rows,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPositionRuntimeReport(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: main,
    errorPrefix: '❌ runtime-position-runtime-report 오류:',
  });
}
