#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  JAENONG_C17_DEFAULTS,
  JAENONG_C17_PARAMETER_KEYS,
  buildJaenongTranchePlan,
  buildJaenongTranchePlanRecord,
  computeJaenongPullbackScore,
  recordJaenongTranchePlan,
} from '../shared/market-regime.ts';
import {
  JAENONG_BLUECHIP_WHITELIST,
  buildOverseasPullbackUniverse,
  normalizeArgosScreeningMode,
} from '../team/argos.ts';

function score(spyDrawdownPct, vix, fearGreed) {
  return computeJaenongPullbackScore({ spyDrawdownPct, vix, fearGreed });
}

async function main() {
  const componentCases = [
    ['fearGreed', 0, 20, 10, 2],
    ['fearGreed', 0, 20, 10.001, 1],
    ['fearGreed', 0, 20, 30, 1],
    ['fearGreed', 0, 20, 30.001, 0],
    ['fearGreed', 0, 20, 70, 0],
    ['fearGreed', 0, 20, 70.001, -1],
    ['spy', -20, 20, 50, 3],
    ['spy', -19.999, 20, 50, 1],
    ['spy', -10, 20, 50, 1],
    ['spy', -9.999, 20, 50, 0],
    ['spy', -5, 20, 50, 0],
    ['spy', -4.999, 20, 50, -1],
    ['vix', 0, 15, 50, -1],
    ['vix', 0, 15.001, 50, 0],
    ['vix', 0, 20, 50, 0],
    ['vix', 0, 20.001, 50, 1],
    ['vix', 0, 29.999, 50, 1],
    ['vix', 0, 30, 50, 2],
  ];
  for (const [component, spyDrawdownPct, vix, fearGreed, expected] of componentCases) {
    assert.equal(
      score(spyDrawdownPct, vix, fearGreed).components[component],
      expected,
      `${component} boundary ${spyDrawdownPct}/${vix}/${fearGreed}`,
    );
  }

  assert.equal(score(-20, 30, 20).total, 6);
  assert.equal(score(-10, 20, 40).total, 1);
  assert.equal(score(-5, 15, 50).total, -1);
  assert.equal(score(-4.99, 14.99, 80).total, -3);
  assert.equal(score(null, 20, 50).available, false);
  assert.equal(score(-10, Number.NaN, 50).available, false);

  assert.deepEqual(buildJaenongTranchePlan(3), {
    action: 'start_first_tranche',
    plannedTranches: 3,
    immediateTranches: 1,
    shadowOnly: true,
  });
  assert.equal(buildJaenongTranchePlan(1).plannedTranches, 1);
  assert.equal(buildJaenongTranchePlan(0).action, 'wait');

  assert.equal(normalizeArgosScreeningMode(undefined), 'top-volume');
  assert.equal(normalizeArgosScreeningMode('pullback'), 'pullback');
  assert.equal(normalizeArgosScreeningMode('unknown'), 'top-volume');

  const raw = [
    { symbol: 'MSFT', currentPrice: 80, high52Week: 100, marketCapUsd: 3_000_000_000_000 },
    { symbol: 'AAPL', currentPrice: 95, high52Week: 100, marketCapUsd: 3_100_000_000_000 },
    { symbol: 'ZZZZ', currentPrice: 50, high52Week: 100, marketCapUsd: 9_000_000_000_000 },
    { symbol: 'NVDA', currentPrice: 60, high52Week: 100, marketCapUsd: 10_000_000 },
  ];
  const universe = buildOverseasPullbackUniverse(raw, {
    minMarketCapUsd: 100_000_000_000,
    maxSymbols: 5,
  });
  assert.deepEqual(universe.map((row) => row.symbol), ['MSFT', 'AAPL']);
  assert.equal(universe[0].drawdownPct, -20);
  assert.ok(JAENONG_BLUECHIP_WHITELIST.includes('MSFT'));
  assert.equal(raw[0].drawdownPct, undefined, 'raw candidates must not be mutated');

  const record = buildJaenongTranchePlanRecord({
    planId: 'JNP-1',
    symbol: 'MSFT',
    score: 3,
    referencePrice: 400,
    createdAt: '2026-01-02T00:00:00.000Z',
  });
  assert.equal(record.status, 'planned_shadow');
  assert.equal(record.executionTime, null);
  assert.equal(record.executionConnected, false);
  let planWrite = null;
  const recorded = await recordJaenongTranchePlan(record, async (sql, params) => {
    planWrite = { sql, params };
    return { rowCount: 1 };
  });
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.status, 'planned_shadow');
  assert.match(planWrite.sql, /planned_shadow/);
  assert.doesNotMatch(planWrite.sql, /order|marketBuy|execution_time\s*=\s*now/i);
  assert.equal(planWrite.params[0], 'JNP-1');
  await assert.rejects(
    recordJaenongTranchePlan({ ...record, createdAt: 'invalid-date' }, async () => {}),
    /jaenong_plan_created_at_invalid/,
  );
  let invalidPriceWriteCalls = 0;
  for (const referencePrice of [0, -1]) {
    const invalidPrice = await recordJaenongTranchePlan(
      { ...record, referencePrice },
      async () => {
        invalidPriceWriteCalls += 1;
        return { rowCount: 1 };
      },
    );
    assert.equal(invalidPrice.recorded, false);
    assert.equal(invalidPrice.reason, 'invalid_reference_price');
  }
  assert.equal(invalidPriceWriteCalls, 0, 'invalid reference prices must skip journal writes');
  const duplicate = await recordJaenongTranchePlan(record, async () => ({ rowCount: 0 }));
  assert.equal(duplicate.recorded, false);
  assert.equal(duplicate.reason, 'duplicate_trade_id');

  assert.equal(JAENONG_C17_DEFAULTS.capitalBudgetRatio, 0.5);
  assert.equal(JAENONG_C17_DEFAULTS.averagingMaxCount, 3);
  assert.equal(JAENONG_C17_DEFAULTS.trackMddCircuitPct, -15);
  assert.equal(JAENONG_C17_DEFAULTS.zoneStopLossAlpha, null);
  assert.equal(JAENONG_C17_PARAMETER_KEYS.zoneStopLossAlpha, 'c17.jaenong.zone_stop_loss_alpha');

  console.log(JSON.stringify({
    ok: true,
    smoke: 'luna-jaenong-j2',
    boundaries: 8,
    legacyModeDefault: normalizeArgosScreeningMode(),
  }, null, 2));
}

main().catch((error) => {
  console.error('luna-jaenong-j2-smoke failed:', error);
  process.exitCode = 1;
});
