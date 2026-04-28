#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { syncPositionsAtMarketOpen } from '../shared/position-sync.ts';
import { summarizeLifecyclePositionSync } from '../shared/position-lifecycle-operational-readiness.ts';
import {
  buildPositionSyncFinalGate,
  normalizeMarketList,
} from '../shared/luna-l5-operational-gate.ts';

function parseArgs(argv = []) {
  const args = {
    json: false,
    markets: ['domestic', 'overseas', 'crypto'],
    requireAllMarkets: true,
  };
  for (const raw of argv) {
    if (raw === '--json') args.json = true;
    else if (raw === '--allow-partial-markets') args.requireAllMarkets = false;
    else if (raw.startsWith('--markets=')) args.markets = normalizeMarketList(raw.split('=').slice(1).join('=') || 'all');
  }
  return args;
}

export async function runPositionSyncFinalGate(args = {}) {
  const checkedAt = new Date().toISOString();
  const markets = normalizeMarketList(args.markets || ['domestic', 'overseas', 'crypto']);
  const results = await Promise.all(markets.map(async (market) => (
    syncPositionsAtMarketOpen(market).catch((error) => ({
      market,
      ok: false,
      error: error?.message || String(error),
      mismatchCount: 0,
      mismatches: [],
    }))
  )));
  const syncSummary = summarizeLifecyclePositionSync(results);
  syncSummary.checkedAt = checkedAt;
  const gate = buildPositionSyncFinalGate({
    syncSummary,
    requiredMarkets: markets,
    requireAllMarkets: args.requireAllMarkets !== false,
    checkedAt,
  });
  return {
    ok: gate.ok,
    status: gate.status,
    checkedAt,
    gate,
    syncSummary,
  };
}

function renderText(result = {}) {
  return [
    '🧾 Luna position sync final gate',
    `status: ${result.status || 'unknown'}`,
    `markets: ${(result.gate?.checkedMarkets || []).join(',') || 'none'}`,
    `mismatches: ${result.gate?.mismatchCount ?? 'n/a'}`,
    `blockers: ${(result.gate?.blockers || []).join(' / ') || 'none'}`,
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runPositionSyncFinalGate(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderText(result));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    before: () => db.initSchema(),
    run: main,
    errorPrefix: '❌ runtime-position-sync-final-gate 실패:',
  });
}
