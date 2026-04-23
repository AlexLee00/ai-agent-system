#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildExecutionFillEnvelope,
  scoreExecutionFillEnvelope,
} from '../shared/execution-fill-envelope.ts';

const full = buildExecutionFillEnvelope({
  trade: {
    id: 'trade-1',
    signal_id: 'sig-1',
    symbol: 'BTC/USDT',
    side: 'buy',
    amount: 0.1,
    price: 100000,
    total_usdt: 10000,
    paper: false,
    exchange: 'binance',
    trade_mode: 'normal',
    execution_origin: 'strategy',
    quality_flag: 'trusted',
  },
  signal: {
    id: 'sig-1',
    symbol: 'BTC/USDT',
    action: 'BUY',
    exchange: 'binance',
    trade_mode: 'normal',
    analyst_signals: 'A:B|O:B|H:N|S:B',
    nemesis_verdict: 'approved',
    strategy_route: { family: 'trend_following', setupType: 'trend_following' },
  },
  journal: {
    trade_id: 'TRD-1',
    signal_id: 'sig-1',
    market_regime: 'trending_bull',
    market_regime_confidence: 0.8,
    status: 'open',
  },
  strategyProfile: {
    id: 'profile-1',
    symbol: 'BTC/USDT',
    exchange: 'binance',
    trade_mode: 'normal',
    status: 'active',
    setup_type: 'trend_following',
    strategy_context: {
      executionPlan: { entrySizingMultiplier: 0.9 },
      responsibilityPlan: { ownerAgent: 'luna' },
    },
    strategy_state: { lifecycleStatus: 'position_open' },
    market_context: { regime: 'trending_bull', confidence: 0.8 },
  },
});

assert.equal(full.symbol, 'BTC/USDT');
assert.equal(full.strategy.profileId, 'profile-1');
assert.equal(full.linkage.hasExecutionPlan, true);
assert.equal(scoreExecutionFillEnvelope(full).status, 'complete');

const weak = buildExecutionFillEnvelope({
  trade: {
    id: 'trade-2',
    symbol: 'ETH/USDT',
    side: 'buy',
    amount: 1,
    price: 3000,
    total_usdt: 3000,
    exchange: 'binance',
  },
});
const weakScore = scoreExecutionFillEnvelope(weak);
assert.equal(weakScore.status, 'weak');
assert.equal(weakScore.missing.includes('signal'), true);
assert.equal(weakScore.missing.includes('strategyProfile'), true);

const restoredRoute = buildExecutionFillEnvelope({
  trade: {
    id: 'trade-3',
    signal_id: 'sig-3',
    symbol: 'AGPU',
    side: 'sell',
    amount: 2,
    price: 7,
    total_usdt: 14,
    exchange: 'kis_overseas',
    trade_mode: 'validation',
  },
  signal: {
    id: 'sig-3',
    analyst_signals: 'A:N|O:N|H:B|S:B',
    nemesis_verdict: 'approved',
  },
  journal: {
    trade_id: 'TRD-3',
    signal_id: 'sig-3',
    status: 'closed',
  },
  strategyProfile: {
    id: 'profile-3',
    symbol: 'AGPU',
    exchange: 'kis_overseas',
    trade_mode: 'validation',
    status: 'closed',
    setup_type: 'mean_reversion',
    strategy_context: {
      executionPlan: { exitUrgency: 'normal' },
      responsibilityPlan: { ownerAgent: 'luna' },
    },
    market_context: '{"regime":"ranging","confidence":0.45}',
  },
});
assert.equal(restoredRoute.linkage.hasStrategyRoute, true);
assert.equal(restoredRoute.strategy.route.source, 'execution_envelope_profile_fallback');
assert.equal(restoredRoute.linkage.hasRegime, true);
assert.equal(scoreExecutionFillEnvelope(restoredRoute).status, 'complete');

const routeOnly = buildExecutionFillEnvelope({
  trade: {
    id: 'trade-4',
    signal_id: 'sig-4',
    symbol: 'NEIRO/USDT',
    side: 'buy',
    amount: 10,
    price: 0.01,
    total_usdt: 0.1,
    exchange: 'binance',
    trade_mode: 'validation',
  },
  signal: {
    id: 'sig-4',
    analyst_signals: 'A:N|O:N|H:N|S:N',
    nemesis_verdict: 'modified',
    strategy_route: { setupType: 'momentum_rotation', selectedFamily: 'momentum_rotation', regime: 'trending_bull' },
  },
  journal: {
    trade_id: 'TRD-4',
    signal_id: 'sig-4',
    status: 'open',
  },
});
assert.equal(routeOnly.linkage.hasExecutionPlan, true);
assert.equal(routeOnly.strategy.executionPlan.source, 'execution_envelope_route_fallback');
assert.equal(routeOnly.linkage.hasResponsibilityPlan, true);
assert.equal(routeOnly.regime.regime, 'trending_bull');

console.log('execution fill envelope smoke ok');
