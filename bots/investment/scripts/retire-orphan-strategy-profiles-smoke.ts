#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildOrphanStrategyProfileCandidates,
  buildOrphanStrategyProfileDecision,
  summarizeOrphanStrategyProfiles,
} from './retire-orphan-strategy-profiles.ts';

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

const summary = summarizeOrphanStrategyProfiles(candidates, {
  apply: false,
  activeProfiles: 3,
  livePositions: 2,
});
assert.equal(summary.orphanProfiles, 1);
assert.equal(summary.orphanSymbols, 1);

const decision = buildOrphanStrategyProfileDecision(summary, { apply: false });
assert.equal(decision.status, 'orphan_strategy_profiles_candidates');
assert.equal(decision.safeToApply, true);
assert.match(decision.actionItems.join('\n'), /orphanSymbols 1/);

const retiredDecision = buildOrphanStrategyProfileDecision({ ...summary, retirements: 1 }, { apply: true });
assert.equal(retiredDecision.status, 'orphan_strategy_profiles_retired');

console.log('retire orphan strategy profiles smoke ok');
