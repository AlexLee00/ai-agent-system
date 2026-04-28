#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildDustStrategyProfileCandidatesFromSnapshots,
  buildRetireDustStrategyProfilesPlan,
} from './retire-dust-strategy-profiles.ts';

const candidates = buildDustStrategyProfileCandidatesFromSnapshots({
  dustThresholdUsdt: 10,
  livePositions: [
    { exchange: 'binance', symbol: 'UTK/USDT', trade_mode: 'normal', amount: 2, avg_price: 1 },
    { exchange: 'binance', symbol: 'BTC/USDT', trade_mode: 'normal', amount: 1, avg_price: 50000 },
  ],
  profilesByKey: {
    'binance|UTK/USDT|normal': { id: 'profile-1', strategy_name: 'dust-test' },
    'binance|BTC/USDT|normal': { id: 'profile-2', strategy_name: 'not-dust' },
  },
});

assert.equal(candidates.length, 1);
assert.equal(candidates[0].symbol, 'UTK/USDT');

const preview = buildRetireDustStrategyProfilesPlan({ candidates, apply: false });
assert.equal(preview.status, 'dust_strategy_profiles_candidates');
assert.match(preview.nextCommand, /--confirm=retire-dust-strategy-profiles/);

const missingConfirm = buildRetireDustStrategyProfilesPlan({ candidates, apply: true, confirm: '' });
assert.equal(missingConfirm.ok, false);
assert.ok(missingConfirm.blockers.includes('confirmation_required'));

const applied = buildRetireDustStrategyProfilesPlan({
  candidates,
  apply: true,
  confirm: 'retire-dust-strategy-profiles',
});
assert.equal(applied.ok, true);
assert.equal(applied.retired, 1);
assert.equal(applied.status, 'dust_strategy_profiles_retired');

console.log(JSON.stringify({ ok: true, preview, applied }, null, 2));
