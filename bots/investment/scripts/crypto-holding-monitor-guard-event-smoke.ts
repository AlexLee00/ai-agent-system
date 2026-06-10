#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { __test } from './crypto-holding-monitor.ts';

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

const previousDisabled = process.env.LUNA_GUARD_EVENT_RECORDING_DISABLED;
const symbol = `SMOKE-EXIT-${Date.now()}/USDT`;

async function main() {
  delete process.env.LUNA_GUARD_EVENT_RECORDING_DISABLED;
  try {
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
    });

    const row = await db.get(
      `SELECT guard_name, symbol, exchange, market, reason, severity,
              decision_before, decision_after, guard_metadata
         FROM investment.guard_events
        WHERE symbol = $1 AND guard_name = 'regime_dynamic_exit'
        ORDER BY id DESC
        LIMIT 1`,
      [symbol],
    );

    assert.ok(row, 'guard event should be persisted synchronously');
    assert.equal(row.guard_name, 'regime_dynamic_exit');
    assert.equal(row.symbol, symbol);
    assert.equal(row.exchange, 'binance');
    assert.equal(row.market, 'crypto');
    assert.equal(row.severity, 'warning');

    const after = asObject(row.decision_after);
    const metadata = asObject(row.guard_metadata);
    assert.equal(after.action, 'WOULD_EXIT_SOFT_CAP');
    assert.equal(after.dryRun, true);
    assert.equal(metadata.executionOrigin, 'regime_dynamic_exit');
    assert.equal(metadata.source, 'crypto-holding-monitor');

    console.log(JSON.stringify({ ok: true, smoke: 'crypto-holding-monitor-guard-event', symbol }));
  } finally {
    await db.run(`DELETE FROM investment.guard_events WHERE symbol = $1`, [symbol]).catch(() => null);
    if (previousDisabled == null) delete process.env.LUNA_GUARD_EVENT_RECORDING_DISABLED;
    else process.env.LUNA_GUARD_EVENT_RECORDING_DISABLED = previousDisabled;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, smoke: 'crypto-holding-monitor-guard-event', error: error?.message || String(error) }));
  process.exit(1);
});
