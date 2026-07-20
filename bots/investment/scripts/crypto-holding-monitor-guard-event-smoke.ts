#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { __test } from './crypto-holding-monitor.ts';

const symbol = `SMOKE-EXIT-${Date.now()}/USDT`;

async function main() {
  const state = __test.buildMonitorStatePayload({
    options: { dryRun: true, json: true },
    candidates: [],
    results: [],
    status: 'no_candidates',
  });
  assert.equal(state.ok, true);
  assert.equal(state.source, 'crypto-holding-monitor');
  assert.equal(state.status, 'no_candidates');
  assert.equal(state.dryRun, true);
  assert.equal(state.sweepEnabled, false);
  assert.equal(state.candidateCount, 0);
  assert.equal(state.processed, 0);
  assert.ok(state.policy);
  assert.equal(state.positionAgeDiagnostics.mismatchCount, 0);

  const mismatchState = __test.buildMonitorStatePayload({
    options: { dryRun: true, json: true },
    candidates: [],
    results: [],
    status: 'no_candidates',
    ageDiagnostics: {
      warningGapDays: 7,
      mismatchCount: 1,
      maxGapDays: 42.1,
      rows: [{ symbol: 'PEPE/USDT', rawTradeHeldDays: 42.3, monitorHeldDays: 0.2, ageGapDays: 42.1 }],
    },
  });
  assert.equal(mismatchState.positionAgeDiagnostics.mismatchCount, 1);
  assert.equal(mismatchState.positionAgeDiagnostics.rows[0].symbol, 'PEPE/USDT');

  const guardEvents = [];
  await __test.recordExitDecision({
    symbol,
    exchange: 'binance',
    market: 'crypto',
    heldDays: 15.5,
    positionValue: 42,
    regime: 'trending_bear',
    regimeFresh: true,
    softCapDays: 5,
    regimePolicy: { maxHoldDays: 5, timeOnlyExit: true },
  }, 'WOULD_EXIT_SOFT_CAP', {
    dryRun: true,
    recommendation: 'SELL',
    revalReason: 'smoke',
    reason: 'crypto holding monitor guard event smoke',
    executionOrigin: 'regime_dynamic_exit',
  }, {
    guardEventSink: async (event) => guardEvents.push(event),
  });

  assert.equal(guardEvents.length, 1, 'guard event should be captured synchronously');
  const [event] = guardEvents;
  assert.equal(event.guardName, 'regime_dynamic_exit');
  assert.equal(event.symbol, symbol);
  assert.equal(event.exchange, 'binance');
  assert.equal(event.market, 'crypto');
  assert.equal(event.severity, 'warning');
  assert.equal(event.decisionAfter.action, 'WOULD_EXIT_SOFT_CAP');
  assert.equal(event.decisionAfter.dryRun, true);
  assert.equal(event.guardMetadata.executionOrigin, 'regime_dynamic_exit');
  assert.equal(event.guardMetadata.source, 'crypto-holding-monitor');

  console.log(JSON.stringify({
    ok: true,
    smoke: 'crypto-holding-monitor-guard-event',
    symbol,
    audit: { sink: 'in_memory', records: guardEvents },
  }));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, smoke: 'crypto-holding-monitor-guard-event', error: error?.message || String(error) }));
  process.exit(1);
});
