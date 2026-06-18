#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from '../shared/db.ts';
import {
  getUniverseSnapshotAsOf,
  persistUniverseSnapshot,
} from '../shared/luna-universe-snapshot.ts';
import { LUNA_COMPONENT_REGISTRY_SEED } from './luna-registry-seed.ts';
import { runLunaRegistryEvaluator } from './runtime-luna-registry-evaluator.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const ROLLBACK_SENTINEL = 'luna_universe_snapshot_smoke_rollback';
const INVESTMENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION_PATH = path.join(INVESTMENT_ROOT, 'migrations', '20260619000003_luna_universe_snapshot.sql');

async function withSmokeRollback(work: any) {
  let output;
  try {
    await db.withTransaction(async (tx: any) => {
      output = await work({ queryFn: tx.query, runFn: tx.run });
      throw new Error(ROLLBACK_SENTINEL);
    });
  } catch (error) {
    if (error?.message !== ROLLBACK_SENTINEL) throw error;
    return output;
  }
  throw new Error('luna_universe_snapshot_smoke_expected_rollback');
}

async function prepareCandidateUniverseForSmoke(runFn: any) {
  await runFn(`
    CREATE TABLE IF NOT EXISTS candidate_universe (
      id            BIGSERIAL PRIMARY KEY,
      symbol        TEXT NOT NULL,
      market        TEXT NOT NULL CHECK (market IN ('domestic', 'overseas', 'crypto')),
      source        TEXT NOT NULL,
      source_tier   INTEGER NOT NULL DEFAULT 2 CHECK (source_tier IN (1, 2)),
      score         NUMERIC(5,4) NOT NULL DEFAULT 0.5000,
      confidence    DOUBLE PRECISION DEFAULT 0.5,
      reason_code   TEXT,
      quality_flags JSONB DEFAULT '[]'::jsonb,
      expires_at    TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
      UNIQUE (symbol, market, source)
    )
  `);
}

async function runSmoke() {
  const stamp = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const smokeSource = `universe_snapshot_smoke_${stamp}`;
  const snapshotDate = '2099-06-19';
  const previousDate = '2099-06-18';
  const olderOverseasDate = '2099-06-17';
  const scenarios = [];

  const transactional = await withSmokeRollback(async ({ queryFn, runFn }: any) => {
    await prepareCandidateUniverseForSmoke(runFn);
    await runFn(fs.readFileSync(MIGRATION_PATH, 'utf8'));
    scenarios.push('migration_dry_run');

    await runFn(
      `INSERT INTO candidate_universe
         (symbol, market, source, source_tier, score, confidence, reason_code, quality_flags, expires_at)
       VALUES
         ($1, 'crypto', $4, 1, 0.9100, 0.82, 'smoke_active_crypto', '["smoke"]'::jsonb, NOW() + INTERVAL '24 hours'),
         ($2, 'domestic', $4, 2, 0.7300, 0.61, 'smoke_active_domestic', '["smoke"]'::jsonb, NOW() + INTERVAL '24 hours'),
         ($3, 'crypto', $4, 2, 0.1200, 0.20, 'smoke_expired', '["expired"]'::jsonb, NOW() - INTERVAL '1 hour')`,
      [`SMOKE/USDT_${stamp}`, `SMOKE${stamp.slice(0, 6)}`, `EXPIRED/USDT_${stamp}`, smokeSource]
    );

    const first = await persistUniverseSnapshot({ dryRun: false, snapshotDate }, { queryFn });
    assert.equal(first.dryRun, false);
    assert.equal(first.snapshotDate, snapshotDate);
    assert.equal(first.inserted, first.totalActive);
    assert(first.totalActive >= 2);
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
      [snapshotDate, smokeSource]
    );
    assert.equal(Number(expiredRows?.[0]?.count || 0), 0);
    scenarios.push('expired_candidates_excluded');

    await runFn(
      `INSERT INTO universe_snapshot
         (snapshot_date, symbol, market, source, source_tier, score, confidence, quality_flags, reason_code)
       VALUES
         ($1::date, $2, 'crypto', $4, 1, 0.5000, 0.5, '[]'::jsonb, 'previous_snapshot'),
         ($5::date, $3, 'overseas', $4, 1, 0.5000, 0.5, '[]'::jsonb, 'previous_snapshot')`,
      [previousDate, `OLDER/USDT_${stamp}`, `OLDERUS_${stamp}`, smokeSource, olderOverseasDate]
    );
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

    return { first, second, asOfSymbols: asOf.symbols.length };
  });

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
