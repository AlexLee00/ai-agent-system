#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildDuplicateStrategyProfileRetirementPlan } from './normalize-duplicate-strategy-profiles.ts';

const plan = buildDuplicateStrategyProfileRetirementPlan({
  managedScopeKeys: new Set(['binance:BTC/USDT']),
  activeProfiles: [
    {
      id: 'keeper',
      exchange: 'binance',
      symbol: 'BTC/USDT',
      trade_mode: 'normal',
      signal_id: 'sig-keeper',
      setup_type: 'momentum',
      updated_at: '2026-04-23T00:00:00.000Z',
      strategy_state: { lifecycleStatus: 'active' },
    },
    {
      id: 'duplicate',
      exchange: 'binance',
      symbol: 'BTC/USDT',
      trade_mode: 'validation',
      signal_id: 'sig-duplicate',
      setup_type: 'momentum',
      updated_at: '2026-04-22T00:00:00.000Z',
      strategy_state: { lifecycleStatus: 'holding' },
    },
    {
      id: 'orphan-eth',
      exchange: 'binance',
      symbol: 'ETH/USDT',
      trade_mode: 'normal',
      signal_id: 'sig-eth',
      updated_at: '2026-04-23T00:00:00.000Z',
    },
    {
      id: 'orphan-eth-2',
      exchange: 'binance',
      symbol: 'ETH/USDT',
      trade_mode: 'validation',
      signal_id: 'sig-eth-2',
      updated_at: '2026-04-22T00:00:00.000Z',
    },
  ],
});

assert.equal(plan.length, 1);
assert.equal(plan[0].key, 'binance:BTC/USDT');
assert.equal(plan[0].keeperProfileId, 'keeper');
assert.equal(plan[0].retirements.length, 1);
assert.equal(plan[0].retirements[0].profileId, 'duplicate');
assert.equal(plan[0].retirements[0].tradeMode, 'validation');

console.log('normalize duplicate strategy profiles smoke ok');
