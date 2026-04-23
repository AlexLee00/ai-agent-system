#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildDuplicateActiveProfileScopes } from './runtime-position-strategy-audit.ts';

export function runRuntimePositionStrategyAuditSmoke() {
  const scopes = buildDuplicateActiveProfileScopes([
    {
      id: 'old-btc',
      exchange: 'binance',
      symbol: 'BTC/USDT',
      trade_mode: 'validation',
      setup_type: 'breakout',
      updated_at: '2026-04-22T00:00:00.000Z',
      strategy_state: { lifecycleStatus: 'watching' },
    },
    {
      id: 'new-btc',
      exchange: 'binance',
      symbol: 'BTC/USDT',
      trade_mode: 'normal',
      setup_type: 'momentum',
      updated_at: '2026-04-23T00:00:00.000Z',
      strategy_state: { lifecycleStatus: 'active' },
    },
    {
      id: 'solo-eth',
      exchange: 'binance',
      symbol: 'ETH/USDT',
      trade_mode: 'normal',
    },
  ]);

  assert.equal(scopes.length, 1);
  assert.equal(scopes[0].key, 'binance:BTC/USDT');
  assert.equal(scopes[0].count, 2);
  assert.equal(scopes[0].keeperProfileId, 'new-btc');
  assert.deepEqual(scopes[0].duplicateProfileIds, ['old-btc']);
  assert.deepEqual(new Set(scopes[0].tradeModes), new Set(['validation', 'normal']));

  return {
    ok: true,
    duplicateScopes: scopes.length,
    keeperProfileId: scopes[0].keeperProfileId,
  };
}

async function main() {
  const result = runRuntimePositionStrategyAuditSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('runtime position strategy audit smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime position strategy audit smoke 실패:',
  });
}
