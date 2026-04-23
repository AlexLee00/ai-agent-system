#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { attachExecutionToPositionStrategy } from '../shared/execution-attach.ts';

const skippedSell = await attachExecutionToPositionStrategy({
  dryRun: true,
  trade: {
    symbol: 'BTC/USDT',
    exchange: 'binance',
    side: 'sell',
    trade_mode: 'normal',
  },
});
assert.equal(skippedSell.status, 'skipped_non_buy');

const skippedScope = await attachExecutionToPositionStrategy({
  dryRun: true,
  trade: { side: 'buy' },
});
assert.equal(skippedScope.status, 'skipped_missing_trade_scope');

console.log('execution attach smoke ok');
