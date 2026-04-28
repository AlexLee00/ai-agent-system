#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runDiscoveryOrchestrator } from '../team/discovery/discovery-orchestrator.ts';
import { buildDiscoveryUniverse, normalizeDiscoverySymbol, toDiscoveryMarket } from '../team/discovery/discovery-universe.ts';

export async function runLunaDiscoveryUniverseSmoke() {
  const market = toDiscoveryMarket('binance');
  assert.equal(market, 'crypto');
  assert.equal(normalizeDiscoverySymbol('BTCUSDT', 'crypto'), 'BTC/USDT');
  assert.equal(normalizeDiscoverySymbol('005930', 'domestic'), '005930');

  const baseUniverse = await buildDiscoveryUniverse('crypto', new Date(), {
    refresh: false,
    fallbackSymbols: ['BTC/USDT', 'ETH/USDT'],
    limit: 40,
  });
  assert.ok(Array.isArray(baseUniverse.symbols));
  assert.ok(baseUniverse.symbols.includes('BTC/USDT'));

  const prev = process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED;
  process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED = 'true';
  const dryRun = await runDiscoveryOrchestrator({
    dryRun: true,
    skipDbWrite: true,
    markets: ['crypto', 'domestic', 'overseas'],
    limit: 10,
  });
  process.env.LUNA_DISCOVERY_ORCHESTRATOR_ENABLED = prev;

  assert.ok(Number(dryRun?.stats?.totalAdapters || 0) >= 3);
  assert.ok(Number(dryRun?.stats?.successCount || 0) >= 1);

  return {
    ok: true,
    market,
    universeSource: baseUniverse.source,
    symbolCount: baseUniverse.symbols.length,
    orchestratorStats: dryRun.stats,
  };
}

async function main() {
  const result = await runLunaDiscoveryUniverseSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna discovery universe smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna discovery universe smoke 실패:',
  });
}
