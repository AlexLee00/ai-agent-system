#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildStockSizingFloorBaselineFilter } from './runtime-decision-report.ts';

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

console.log('✅ runtime decision baseline smoke passed');
