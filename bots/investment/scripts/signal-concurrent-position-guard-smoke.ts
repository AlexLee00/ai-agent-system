// @ts-nocheck
import assert from 'node:assert/strict';
import { hasOpenPositionForSymbol as signalHasOpenPositionForSymbol } from '../shared/signal.ts';
import { hasOpenPositionForSymbol as capitalHasOpenPositionForSymbol } from '../shared/capital-manager.ts';

const positions = [
  { symbol: 'BTC/USDT' },
  { symbol: 'MOVR/USDT' },
];

for (const fn of [signalHasOpenPositionForSymbol, capitalHasOpenPositionForSymbol]) {
  assert.equal(fn(positions, 'BTC/USDT'), true, 'existing symbol should not consume a new concurrent slot');
  assert.equal(fn(positions, 'btc/usdt'), true, 'symbol match is case-insensitive');
  assert.equal(fn(positions, 'ETH/USDT'), false, 'new symbol should still consume a concurrent slot');
}

const result = {
  ok: true,
  existingSymbolAddsSlot: false,
  newSymbolAddsSlot: true,
};

if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else console.log('signal-concurrent-position-guard-smoke ok');
