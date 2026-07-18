#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyRetentionDraft,
  collectRetentionV2DraftPlan,
  isRetentionDraftCandidate,
} from './runtime-event-lake-retention-v2-draft.ts';

const require = createRequire(import.meta.url);
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pgPool = require(path.join(PROJECT_ROOT, 'packages/core/lib/pg-pool.ts'));
const FIXED_NOW = new Date('2026-07-19T00:00:00.000Z');

async function runPartitionSimulation() {
  return pgPool.transaction('agent', async (client) => {
    await client.query("SET LOCAL statement_timeout = '5s'");
    await client.query(`
      CREATE TEMP TABLE event_lake_partition_sim (
        id bigint NOT NULL,
        event_type text NOT NULL,
        created_at timestamptz NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (id, created_at)
      ) PARTITION BY RANGE (created_at)
      ON COMMIT DROP
    `);
    await client.query(`
      DO $simulation_partitions$
      DECLARE
        month_offset integer;
        partition_start timestamptz;
        partition_end timestamptz;
        partition_name text;
      BEGIN
        FOR month_offset IN 0..1 LOOP
          partition_start := TIMESTAMPTZ '2026-06-01T00:00:00Z'
            + make_interval(months => month_offset);
          partition_end := partition_start + INTERVAL '1 month';
          partition_name := 'event_lake_partition_sim_' || to_char(partition_start, 'YYYYMM');
          EXECUTE format(
            'CREATE TEMP TABLE %I PARTITION OF event_lake_partition_sim '
              || 'FOR VALUES FROM (%L) TO (%L) ON COMMIT DROP',
            partition_name,
            partition_start,
            partition_end
          );
        END LOOP;
      END
      $simulation_partitions$
    `);
    await client.query(`
      CREATE TEMP TABLE event_lake_partition_sim_default
      PARTITION OF event_lake_partition_sim DEFAULT
      ON COMMIT DROP
    `);
    await client.query(`
      INSERT INTO event_lake_partition_sim (id, event_type, created_at)
      VALUES
        (1, 'luna.tv.bar.BINANCE:BTCUSDT.60', '2026-06-15T00:00:00Z'),
        (2, 'port_agent_run', '2026-07-15T00:00:00Z')
    `);
    const before = await client.query(`
      SELECT tableoid::regclass::text AS partition_name, COUNT(*)::int AS rows
      FROM event_lake_partition_sim
      GROUP BY tableoid
      ORDER BY partition_name
    `);
    assert.equal(before.rows.length, 2);
    const defaultRows = await client.query(
      'SELECT COUNT(*)::int AS rows FROM event_lake_partition_sim_default',
    );
    assert.equal(defaultRows.rows[0].rows, 0);

    await client.query(`
      ALTER TABLE event_lake_partition_sim
      DETACH PARTITION event_lake_partition_sim_202606
    `);
    const after = await client.query('SELECT COUNT(*)::int AS rows FROM event_lake_partition_sim');
    const detached = await client.query('SELECT COUNT(*)::int AS rows FROM event_lake_partition_sim_202606');
    assert.equal(after.rows[0].rows, 1);
    assert.equal(detached.rows[0].rows, 1);
    await client.query('DROP TABLE event_lake_partition_sim_202606');
    return {
      partitionsBefore: 2,
      defaultRows: 0,
      parentRowsAfterDetach: 1,
      detachedRowsBeforeDrop: 1,
    };
  });
}

async function main() {
  const migrationDraft = fs.readFileSync(
    path.join(PROJECT_ROOT, 'scripts/sql/event-lake-tv-bar-partition-v2-draft.sql'),
    'utf8',
  );
  assert.match(migrationDraft, /CREATE TABLE agent\.event_lake_tv_bar_v2/);
  assert.match(migrationDraft, /PARTITION BY RANGE \(created_at\)/);
  assert.match(migrationDraft, /FOR month_offset IN 0\.\.2 LOOP/);
  assert.doesNotMatch(migrationDraft, /event_lake_tv_bar_v2_202[0-9]{3}/);
  assert.doesNotMatch(migrationDraft, /(?:ALTER|DROP|DELETE FROM)\s+(?:TABLE\s+)?agent\.event_lake\b/i);

  assert.equal(classifyRetentionDraft('luna.tv.bar.BINANCE:BTCUSDT.60').hotDays, 30);
  assert.equal(classifyRetentionDraft('port_agent_run').hotDays, 90);
  assert.deepEqual(classifyRetentionDraft('decision.allow'), {
    className: 'unknown_or_durable',
    hotDays: null,
    action: 'keep',
  });
  assert.equal(isRetentionDraftCandidate({
    event_type: 'luna.tv.bar.BINANCE:BTCUSDT.60',
    created_at: '2026-06-18T23:59:59.999Z',
  }, FIXED_NOW), true);
  assert.equal(isRetentionDraftCandidate({
    event_type: 'decision.allow',
    created_at: '2025-01-01T00:00:00.000Z',
  }, FIXED_NOW), false);
  assert.equal(isRetentionDraftCandidate({ event_type: 'port_agent_run' }, FIXED_NOW), false);

  const plan = await collectRetentionV2DraftPlan({
    queryReadonly: async (_schema, sql, params) => {
      assert.match(sql, /event_type = ANY/);
      assert.equal(params[1], 30);
      assert.equal(params[2], 90);
      return [{
        class_name: 'ephemeral_runtime',
        candidate_rows: '190513',
        oldest_at: '2026-04-08T00:00:00Z',
        newest_at: '2026-04-20T00:00:00Z',
      }];
    },
  });
  assert.equal(plan.applySupported, false);
  assert.equal(plan.unknownAction, 'keep');
  assert.equal(plan.candidates[0].rows, 190513);

  const partitionSimulation = await runPartitionSimulation();
  console.log(JSON.stringify({
    ok: true,
    smoke: 'event-lake-retention-v2-draft',
    checks: {
      explicitAllowlist: true,
      unknownKeep: true,
      applyUnavailable: true,
      migrationDraftLiveTableSafe: true,
      dynamicUtcPartitions: true,
      defaultPartitionEmpty: true,
      pgTempPartitionDetachDrop: true,
    },
    partitionSimulation,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
  process.exitCode = 1;
});
