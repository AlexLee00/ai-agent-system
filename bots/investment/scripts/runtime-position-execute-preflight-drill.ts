#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runPositionRuntimeAutopilot } from './runtime-position-runtime-autopilot.ts';
import { runPositionRuntimeDispatch } from './runtime-position-runtime-dispatch.ts';
import {
  buildExecutePreflightDrill,
  buildPositionSyncFinalGate,
  normalizeMarketList,
} from '../shared/luna-l5-operational-gate.ts';

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

export async function runPositionExecutePreflightDrill(args = {}) {
  const markets = normalizeMarketList(args.markets || ['domestic', 'overseas', 'crypto']);
  const [autopilotPreview, dispatchPreview] = await Promise.all([
    runPositionRuntimeAutopilot({
      exchange: args.exchange || null,
      limit: args.limit || 5,
      json: true,
      recordHistory: false,
      requirePositionSync: false,
      positionSyncMarkets: markets,
    }),
    runPositionRuntimeDispatch({
      exchange: args.exchange || null,
      limit: args.limit || 5,
      phase6: true,
      json: true,
    }),
  ]);

  const positionSyncGate = args.requirePositionSync
    ? buildPositionSyncFinalGate({
      syncSummary: autopilotPreview.positionSyncSummary || null,
      requiredMarkets: markets,
    })
    : null;
  const drill = buildExecutePreflightDrill({
    autopilotPreview,
    dispatchPreview,
    lifecycleReadiness: autopilotPreview.lifecycleReadiness || null,
    positionSyncGate,
  });
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
