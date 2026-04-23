#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildStockSizingFloorBaselineFilter, isDustExitOutcome, isPositionStateMissOutcome } from './runtime-decision-report.ts';

const all = buildStockSizingFloorBaselineFilter({ market: 'all' });
assert.match(all, /kis/);
assert.match(all, /kis_overseas/);
assert.match(all, /min_order_notional/);
assert.match(all, /sizing_floor_unavailable/);
assert.match(all, /TIMESTAMPTZ/);

const domestic = buildStockSizingFloorBaselineFilter({ market: 'domestic' });
assert.match(domestic, /exchange = 'kis'/);
assert.doesNotMatch(domestic, /kis_overseas/);

const overseas = buildStockSizingFloorBaselineFilter({ market: 'overseas' });
assert.match(overseas, /kis_overseas/);
assert.doesNotMatch(overseas, /exchange = 'kis'/);

const crypto = buildStockSizingFloorBaselineFilter({ market: 'crypto' });
assert.equal(crypto, '');

assert.equal(isDustExitOutcome({ status: 'skipped_below_min', blockCode: 'sell_amount_below_minimum' }), true);
assert.equal(isDustExitOutcome({ status: 'failed', blockCode: 'sell_amount_below_minimum' }), true);
assert.equal(isDustExitOutcome({ status: 'failed', blockCode: 'partial_sell_below_minimum' }), true);
assert.equal(isDustExitOutcome({ status: 'executed', blockCode: 'sell_amount_below_minimum' }), false);
assert.equal(isDustExitOutcome({ status: 'failed', blockCode: 'missing_position' }), false);

assert.equal(isPositionStateMissOutcome({ status: 'failed', blockCode: 'missing_position' }), true);
assert.equal(isPositionStateMissOutcome({ status: 'blocked', blockCode: 'missing_position' }), true);
assert.equal(isPositionStateMissOutcome({ status: 'executed', blockCode: 'missing_position' }), false);
assert.equal(isPositionStateMissOutcome({ status: 'failed', blockCode: 'sell_amount_below_minimum' }), false);

console.log('✅ runtime decision baseline smoke passed');
