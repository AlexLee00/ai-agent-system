#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  REGIMES,
  assessMarketRegimeDataQuality,
  classifyMarketRegime,
  shouldCacheMarketRegimeResult,
} from '../shared/market-regime.ts';
import { evaluateMarketRegimeExecutionSafety } from '../team/nemesis.ts';

const failedSnapshots = [
  { symbol: 'BTCUSDT', label: 'BTC', source: 'binance', error: 'timeout', last: null, dayChangePct: 0, trendPct: 0 },
  { symbol: 'ETHUSDT', label: 'ETH', source: 'binance', error: 'timeout', last: null, dayChangePct: 0, trendPct: 0 },
];

const failedQuality = assessMarketRegimeDataQuality(failedSnapshots, 2);
assert.equal(failedQuality.dataAvailable, false);
assert.equal(failedQuality.usableCount, 0);
assert.equal(failedQuality.failedCount, 2);

const unknown = classifyMarketRegime('binance', 'neutral', failedSnapshots, {}, 2);
assert.equal(unknown.regime, REGIMES.UNKNOWN, 'provider outage must not be classified as ranging');
assert.equal(unknown.confidence, 0);
assert.equal(unknown.guide.positionSizeMultiplier, 0);
assert.equal(unknown.degraded, true);
assert.equal(unknown.dataAvailable, false);
assert.equal(shouldCacheMarketRegimeResult(unknown), false, 'provider outage must be fetched again on retry');
const unknownSafety = evaluateMarketRegimeExecutionSafety(unknown);
assert.equal(unknownSafety.approved, false);
assert.equal(unknownSafety.retryable, true, 'temporary benchmark outages must use bounded retry before terminalization');

const partialSnapshots = [
  { symbol: 'BTCUSDT', label: 'BTC', source: 'binance', last: 100, dayChangePct: 1.2, trendPct: 2.4 },
  failedSnapshots[1],
];
const partial = classifyMarketRegime('binance', 'bullish', partialSnapshots, {}, 2);
assert.notEqual(partial.regime, REGIMES.UNKNOWN);
assert.equal(partial.degraded, true);
assert.equal(partial.dataAvailable, true);
assert.equal(shouldCacheMarketRegimeResult(partial), true, 'usable degraded data may be cached');
assert.ok(partial.guide.positionSizeMultiplier <= 1, 'degraded data must never increase position size');
assert.equal(evaluateMarketRegimeExecutionSafety(partial).approved, true);

const healthySnapshots = [
  { symbol: 'BTCUSDT', label: 'BTC', source: 'binance', last: 100, dayChangePct: 1.2, trendPct: 2.4 },
  { symbol: 'ETHUSDT', label: 'ETH', source: 'binance', last: 80, dayChangePct: 0.9, trendPct: 1.8 },
];
const healthy = classifyMarketRegime('binance', 'bullish', healthySnapshots, {}, 2);
assert.equal(healthy.regime, REGIMES.TRENDING_BULL);
assert.equal(healthy.degraded, false);
assert.equal(healthy.dataAvailable, true);

console.log(JSON.stringify({ ok: true, failedQuality, unknown, partial, healthy }, null, 2));
