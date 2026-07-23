#!/usr/bin/env node
// @ts-nocheck
// Canonical smoke: operations DB contact is forbidden; persistence uses an in-memory snapshot ledger.

import assert from 'assert/strict';
import {
  getUniverseSnapshotAsOf,
  persistUniverseSnapshot,
} from '../shared/luna-universe-snapshot.ts';
import { LUNA_COMPONENT_REGISTRY_SEED } from './luna-registry-seed.ts';
import { runLunaRegistryEvaluator } from './runtime-luna-registry-evaluator.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  const stamp = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const smokeSource = `universe_snapshot_smoke_${stamp}`;
  const snapshotDate = '2099-06-19';
  const previousDate = '2099-06-18';
  const olderOverseasDate = '2099-06-17';
  const scenarios = [];

  const activeRows = [
    { symbol: `SMOKE/USDT_${stamp}`, market: 'crypto', source: smokeSource, source_tier: 1, score: 0.91, confidence: 0.82, reason_code: 'smoke_active_crypto', quality_flags: ['smoke'] },
    { symbol: `SMOKE${stamp.slice(0, 6)}`, market: 'domestic', source: smokeSource, source_tier: 2, score: 0.73, confidence: 0.61, reason_code: 'smoke_active_domestic', quality_flags: ['smoke'] },
  ];
  const snapshots = [
    { snapshot_date: previousDate, symbol: `OLDER/USDT_${stamp}`, market: 'crypto', source: smokeSource, source_tier: 1, score: 0.5, confidence: 0.5, quality_flags: [], reason_code: 'previous_snapshot' },
    { snapshot_date: olderOverseasDate, symbol: `OLDERUS_${stamp}`, market: 'overseas', source: smokeSource, source_tier: 1, score: 0.5, confidence: 0.5, quality_flags: [], reason_code: 'previous_snapshot' },
  ];
  const queryFn = async (sql: string, params: any[] = []) => {
    if (/INSERT INTO universe_snapshot/i.test(sql) && /FROM active/i.test(sql)) {
      const date = String(params[0] || snapshotDate).slice(0, 10);
      let inserted = 0;
      for (const row of activeRows) {
        const exists = snapshots.some((item) => item.snapshot_date === date && item.symbol === row.symbol && item.market === row.market && item.source === row.source);
        if (!exists) {
          snapshots.push({ ...row, snapshot_date: date });
          inserted += 1;
        }
      }
      return [{ snapshot_date: date, total_active: activeRows.length, inserted }];
    }
    if (/reason_code = 'smoke_expired'/i.test(sql)) return [{ count: 0 }];
    if (/WITH latest AS/i.test(sql)) {
      const asOfDate = String(params[0]).slice(0, 10);
      const market = params[1] || null;
      const eligible = snapshots.filter((row) => row.snapshot_date <= asOfDate && (!market || row.market === market));
      const latestByMarket = {};
      for (const row of eligible) {
        if (!latestByMarket[row.market] || row.snapshot_date > latestByMarket[row.market]) latestByMarket[row.market] = row.snapshot_date;
      }
      return eligible.filter((row) => latestByMarket[row.market] === row.snapshot_date);
    }
    throw new Error(`unexpected_universe_snapshot_sql:${sql}`);
  };

  const before = snapshots.length;
  const first = await persistUniverseSnapshot({ dryRun: false, snapshotDate }, { queryFn });
  assert.equal(first.dryRun, false);
  assert.equal(first.snapshotDate, snapshotDate);
  assert.equal(first.inserted, first.totalActive);
  assert.equal(first.totalActive, 2);
  scenarios.push('persist_first_run_all_active');

  const second = await persistUniverseSnapshot({ dryRun: false, snapshotDate }, { queryFn });
  assert.equal(second.inserted, 0);
  assert.equal(second.totalActive, first.totalActive);
  scenarios.push('persist_idempotent_second_run');

  const expiredRows = await queryFn(
    `SELECT COUNT(*)::int AS count
       FROM universe_snapshot
      WHERE snapshot_date = $1::date
        AND source = $2
        AND reason_code = 'smoke_expired'`,
    [snapshotDate, smokeSource],
  );
  assert.equal(Number(expiredRows?.[0]?.count || 0), 0);
  scenarios.push('expired_candidates_excluded');

  const asOf = await getUniverseSnapshotAsOf({ asOfDate: snapshotDate, market: 'crypto' }, { queryFn });
  assert.equal(asOf.snapshotDate, snapshotDate);
  assert(asOf.symbols.includes(`SMOKE/USDT_${stamp}`));
  assert(!asOf.symbols.includes(`OLDER/USDT_${stamp}`));
  scenarios.push('asof_latest_snapshot');

  const allMarketAsOf = await getUniverseSnapshotAsOf({ asOfDate: previousDate }, { queryFn });
  assert.equal(allMarketAsOf.snapshotDatesByMarket.crypto, previousDate);
  assert.equal(allMarketAsOf.snapshotDatesByMarket.overseas, olderOverseasDate);
  assert(allMarketAsOf.symbols.includes(`OLDERUS_${stamp}`));
  scenarios.push('asof_latest_snapshot_per_market');

  const transactional = { first, second, asOfSymbols: asOf.symbols.length, before, after: snapshots.length };
  assert.equal(transactional.after - transactional.before, 2);

  let evaluatorSnapshotCalls = 0;
  const evaluator = await runLunaRegistryEvaluator({
    dryRun: true,
    rows: [],
    skipCalibration: true,
    skipAlpha: true,
    skipPaperMirror: true,
  }, {
    persistUniverseSnapshot: async (options: any) => {
      evaluatorSnapshotCalls += 1;
      assert.equal(options.dryRun, true);
      return { ok: true, dryRun: true, snapshotDate, inserted: 0, totalActive: 3 };
    },
  });
  assert.equal(evaluatorSnapshotCalls, 1);
  assert.equal(evaluator.universeSnapshot.ok, true);
  assert.equal(evaluator.universeSnapshot.inserted, 0);
  scenarios.push('evaluator_piggyback_dry_run');

  const evaluatorSkip = await runLunaRegistryEvaluator({
    dryRun: true,
    rows: [],
    skipCalibration: true,
    skipAlpha: true,
    skipPaperMirror: true,
    skipUniverseSnapshot: true,
  }, {
    persistUniverseSnapshot: async () => {
      throw new Error('snapshot_should_not_run');
    },
  });
  assert.equal(evaluatorSkip.universeSnapshot.skipped, true);
  scenarios.push('evaluator_skip_flag');

  const evaluatorFailure = await runLunaRegistryEvaluator({
    dryRun: true,
    rows: [],
    skipCalibration: true,
    skipAlpha: true,
    skipPaperMirror: true,
  }, {
    persistUniverseSnapshot: async () => {
      throw new Error('snapshot_down');
    },
  });
  assert.equal(evaluatorFailure.ok, true);
  assert.equal(evaluatorFailure.universeSnapshot.ok, false);
  assert.equal(evaluatorFailure.universeSnapshot.error, 'snapshot_down');
  scenarios.push('evaluator_fail_open');

  const components = LUNA_COMPONENT_REGISTRY_SEED.map((row: any) => row.component);
  assert(components.includes('universe-snapshot-accumulator'));
  scenarios.push('registry_seed_contains_universe_snapshot');

  return {
    ok: true,
    smoke: 'luna-universe-snapshot',
    transactional,
    scenarios,
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runSmoke,
    onSuccess: async (result) => console.log(JSON.stringify(result, null, 2)),
    errorPrefix: '❌ luna-universe-snapshot-smoke 실패:',
  });
}
