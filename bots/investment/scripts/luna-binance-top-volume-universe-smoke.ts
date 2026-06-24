#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  BINANCE_TOP_VOLUME_BLOCK_REASON,
  buildFixtureBinanceTopVolumeUniverse,
  evaluateBinanceTopVolumeUniverseGate,
} from '../shared/binance-top-volume-universe.ts';
import { runLunaBinanceTopVolumeUniverse } from './runtime-luna-binance-top-volume-universe.ts';

export async function runLunaBinanceTopVolumeUniverseSmoke() {
  const universe = buildFixtureBinanceTopVolumeUniverse();
  assert.equal(universe.symbols.length, 30);
  assert.equal(universe.source, 'binance_spot_usdt_quote_volume_top');
  assert.equal(universe.symbols.includes('USDC/USDT'), false, 'stablecoin base must be excluded before ranking');
  assert.equal(universe.symbols.includes('BTCUP/USDT'), false, 'leveraged token must be excluded before ranking');
  assert.equal(universe.ranks['BTC/USDT'], 1);
  const inUniverse = evaluateBinanceTopVolumeUniverseGate('BTCUSDT', universe);
  assert.equal(inUniverse.ok, true);
  assert.equal(inUniverse.reason, 'in_binance_top_volume_universe');
  assert.equal(inUniverse.code, 'in_binance_top_volume_universe');
  const offUniverse = evaluateBinanceTopVolumeUniverseGate('PEPE/USDT', universe);
  assert.equal(offUniverse.blocked, true);
  assert.equal(offUniverse.reason, BINANCE_TOP_VOLUME_BLOCK_REASON);
  assert.equal(offUniverse.reason, 'outside_binance_top_volume_universe');

  const expandedUniverse = buildFixtureBinanceTopVolumeUniverse({ limit: 50 });
  assert.equal(expandedUniverse.limit, 50);
  assert.equal(expandedUniverse.symbols.length, 35);
  assert.equal(expandedUniverse.symbols.includes('USDC/USDT'), false, 'stablecoin base must stay excluded with expanded limit');
  assert.equal(expandedUniverse.symbols.includes('BTCUP/USDT'), false, 'leveraged token must stay excluded with expanded limit');

  const runtime = await runLunaBinanceTopVolumeUniverse({ json: true, dryRun: true, fixture: true });
  assert.equal(runtime.ok, true);
  assert.equal(runtime.universe.symbols.length, 30);
  assert.ok(runtime.excludedActiveCandidates.some((item) => item.symbol === 'PEPE/USDT'));
  assert.ok(runtime.excludedActiveCandidates.some((item) => item.symbol === 'USDC/USDT'));
  assert.ok(runtime.offUniverseHoldings.some((item) => item.symbol === 'PEPE/USDT' && item.liquidationCandidate));

  return {
    ok: true,
    smoke: 'luna-binance-top-volume-universe',
    topCount: universe.symbols.length,
    expandedTopCount: expandedUniverse.symbols.length,
    stableExcluded: !universe.symbols.includes('USDC/USDT'),
    leveragedExcluded: !universe.symbols.includes('BTCUP/USDT'),
    excludedActiveCandidates: runtime.excludedActiveCandidates.length,
    offUniverseHoldings: runtime.offUniverseHoldings.length,
  };
}

async function main() {
  const result = await runLunaBinanceTopVolumeUniverseSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-binance-top-volume-universe-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna-binance-top-volume-universe-smoke error:',
  });
}
