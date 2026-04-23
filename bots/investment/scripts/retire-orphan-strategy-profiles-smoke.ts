#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildOrphanStrategyProfileCandidates } from './retire-orphan-strategy-profiles.ts';

const candidates = buildOrphanStrategyProfileCandidates({
  livePositions: [
    { exchange: 'binance', symbol: 'BTC/USDT' },
    { exchange: 'kis', symbol: '005930' },
  ],
  activeProfiles: [
    { id: 'a', exchange: 'binance', symbol: 'BTC/USDT', trade_mode: 'normal', setup_type: 'momentum' },
    { id: 'b', exchange: 'kis', symbol: '005090', trade_mode: 'normal', setup_type: 'mean_reversion', strategy_state: { lifecycleStatus: 'unknown' } },
    { id: 'c', exchange: 'kis', symbol: '005930', trade_mode: 'normal', setup_type: 'breakout' },
  ],
});

assert.equal(candidates.length, 1);
assert.equal(candidates[0].symbol, '005090');
assert.equal(candidates[0].exchange, 'kis');
assert.equal(candidates[0].tradeMode, 'normal');
assert.equal(candidates[0].lifecycleStatus, 'unknown');

console.log('retire orphan strategy profiles smoke ok');
