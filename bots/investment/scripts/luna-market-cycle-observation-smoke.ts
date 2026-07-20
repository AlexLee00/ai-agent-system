#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import { buildMarketCycleObservationReport, _testOnly } from './runtime-luna-market-cycle-observation.ts';

const generatedAt = '2026-07-20T14:00:00.000Z';
const nightCryptoCadence = _testOnly.resolveCycleCadenceSeconds({
  name: 'market_cycle_crypto',
  cadence: { seconds: 300 },
}, { cycleSec: 3600 });
assert.equal(nightCryptoCadence, 3600);

const healthy = buildMarketCycleObservationReport({
  generatedAt,
  service: {
    loaded: true,
    state: 'not running',
    runs: 100,
    lastExitCode: 0,
    runIntervalSeconds: 60,
  },
  schedulerState: {
    updatedAt: '2026-07-20T13:59:30.000Z',
    jobs: {
      market_cycle_crypto: {
        lastRunAt: '2026-07-20T13:57:00.000Z',
        lastOpenRunAt: '2026-07-20T13:55:00.000Z',
        lastStatus: 'ok',
        lastOutcome: 'cadence_wait',
        consecutiveFailures: 0,
      },
      market_cycle_domestic: {
        lastRunAt: '2026-07-20T06:07:00.000Z',
        lastStatus: 'ok',
        lastOutcome: 'no_signals',
        consecutiveFailures: 0,
      },
      market_cycle_overseas: {
        lastRunAt: '2026-07-20T13:35:00.000Z',
        lastStatus: 'ok',
        lastOutcome: 'no_signals',
        consecutiveFailures: 0,
      },
    },
  },
  marketSessions: {
    crypto: { isOpen: true, state: 'open', reasonCode: 'always_open' },
    domestic: { isOpen: false, state: 'closed', reasonCode: 'kis_market_closed' },
    overseas: { isOpen: true, state: 'open', reasonCode: 'kis_market_open' },
  },
  cycleDefinitions: [
    { name: 'market_cycle_crypto', market: 'crypto', cadenceSeconds: 300 },
    { name: 'market_cycle_domestic', market: 'domestic', cadenceSeconds: 1800 },
    { name: 'market_cycle_overseas', market: 'overseas', cadenceSeconds: 1800 },
  ],
  tradeRows: [
    { market: 'crypto', recent_events: 2, open_positions: 1, last_event_ms: 1_768_000_000_000 },
  ],
});

assert.equal(healthy.status, 'healthy');
assert.equal(healthy.service.status, 'healthy');
assert.equal(healthy.markets.crypto.status, 'healthy');
assert.equal(healthy.markets.domestic.status, 'healthy');
assert.deepEqual(healthy.markets.domestic.reasons, ['market_closed']);
assert.equal(healthy.markets.overseas.status, 'healthy');
assert.equal(healthy.liveMutation, false);
assert.equal(healthy.dbWrite, false);
assert.equal(healthy.schedulerKick, false);

const incomplete = buildMarketCycleObservationReport({
  generatedAt,
  service: healthy.service,
  schedulerState: {
    updatedAt: '2026-07-20T13:59:30.000Z',
    jobs: {
      market_cycle_crypto: {
        lastRunAt: '2026-07-20T13:57:00.000Z',
        lastStatus: 'ok',
      },
    },
  },
  marketSessions: {
    crypto: { isOpen: true, state: 'open', reasonCode: 'always_open' },
    domestic: { isOpen: false, state: 'closed', reasonCode: 'kis_market_closed' },
    overseas: { isOpen: false, state: 'closed', reasonCode: 'kis_market_closed' },
  },
  cycleDefinitions: [
    { name: 'market_cycle_crypto', market: 'crypto', cadenceSeconds: 300 },
    { name: 'market_cycle_domestic', market: 'domestic', cadenceSeconds: 1800 },
    { name: 'market_cycle_overseas', market: 'overseas', cadenceSeconds: 1800 },
  ],
  tradeRows: [],
});

assert.equal(incomplete.status, 'incomplete');
assert.equal(incomplete.ok, false);
assert.equal(incomplete.markets.crypto.status, 'healthy');
assert.equal(incomplete.markets.domestic.status, 'no_sample');

const stale = buildMarketCycleObservationReport({
  generatedAt,
  service: healthy.service,
  schedulerState: {
    updatedAt: '2026-07-20T13:59:30.000Z',
    jobs: {
      market_cycle_crypto: {
        lastRunAt: '2026-07-20T13:00:00.000Z',
        lastStatus: 'ok',
        lastOutcome: 'no_signals',
      },
    },
  },
  marketSessions: {
    crypto: { isOpen: true, state: 'open', reasonCode: 'always_open' },
    domestic: { isOpen: false, state: 'closed', reasonCode: 'kis_market_closed' },
    overseas: { isOpen: false, state: 'closed', reasonCode: 'kis_market_closed' },
  },
  cycleDefinitions: [
    { name: 'market_cycle_crypto', market: 'crypto', cadenceSeconds: 300 },
    { name: 'market_cycle_domestic', market: 'domestic', cadenceSeconds: 1800 },
    { name: 'market_cycle_overseas', market: 'overseas', cadenceSeconds: 1800 },
  ],
  tradeRows: [],
});

assert.equal(stale.status, 'degraded');
assert.equal(stale.markets.crypto.status, 'degraded');
assert.ok(stale.markets.crypto.reasons.includes('cycle_stale'));
assert.equal(stale.markets.domestic.status, 'no_sample');

const longClosed = buildMarketCycleObservationReport({
  generatedAt,
  service: healthy.service,
  schedulerState: {
    updatedAt: '2026-07-20T13:59:30.000Z',
    jobs: {
      market_cycle_domestic: {
        lastRunAt: '2026-07-20T13:58:00.000Z',
        lastOpenRunAt: '2026-07-01T06:07:00.000Z',
        lastStatus: 'ok',
        lastOutcome: 'market_closed_skip',
      },
    },
  },
  marketSessions: {
    domestic: { isOpen: false, state: 'closed', reasonCode: 'kis_market_closed' },
  },
  cycleDefinitions: [
    { name: 'market_cycle_domestic', market: 'domestic', cadenceSeconds: 1800 },
  ],
  tradeRows: [],
});

assert.equal(longClosed.status, 'degraded');
assert.equal(longClosed.markets.domestic.status, 'degraded');
assert.ok(longClosed.markets.domestic.reasons.includes('last_open_cycle_stale'));
assert.equal(longClosed.markets.domestic.lastRunAt, '2026-07-20T13:58:00.000Z');
assert.equal(longClosed.markets.domestic.lastOpenRunAt, '2026-07-01T06:07:00.000Z');

const queryError = buildMarketCycleObservationReport({
  generatedAt,
  service: {
    loaded: true,
    state: 'not running',
    runs: 100,
    lastExitCode: 0,
    runIntervalSeconds: 60,
  },
  schedulerState: {
    updatedAt: '2026-07-20T13:59:30.000Z',
    jobs: {
      market_cycle_crypto: {
        lastRunAt: '2026-07-20T13:57:00.000Z',
        lastStatus: 'ok',
      },
    },
  },
  marketSessions: {
    crypto: { isOpen: true, state: 'open', reasonCode: 'always_open' },
  },
  cycleDefinitions: [
    { name: 'market_cycle_crypto', market: 'crypto', cadenceSeconds: 300 },
  ],
  tradeRows: [],
  tradeQueryError: 'readonly_query_failed',
});

assert.equal(queryError.status, 'degraded');
assert.equal(queryError.tradeJournal.status, 'query_error');
assert.equal(queryError.tradeJournal.error, 'readonly_query_failed');

console.log(JSON.stringify({
  ok: true,
  healthyStatus: healthy.status,
  incompleteStatus: incomplete.status,
  staleStatus: stale.status,
  longClosedStatus: longClosed.markets.domestic.status,
  queryErrorStatus: queryError.tradeJournal.status,
  liveMutation: healthy.liveMutation,
}));
