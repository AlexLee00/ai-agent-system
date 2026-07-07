#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  applyRetention,
  archiveCandidates,
  buildRetentionCutoffs,
  classifyEventType,
  collectRetentionCounts,
  isRetentionCandidate,
  normalizePolicy,
  runEventLakeRetention,
} from './runtime-event-lake-retention.ts';

const FIXED_NOW = new Date('2026-07-07T00:00:00.000Z');

function makeQueryReadonly() {
  let archiveSelects = 0;
  const calls = [];
  async function queryReadonly(schema, sql, params = []) {
    calls.push({ schema, sql, params });
    if (sql.includes('pg_total_relation_size')) {
      return [{ total_bytes: '100000', heap_bytes: '60000', index_bytes: '40000' }];
    }
    if (sql.includes('COUNT(*)::bigint AS total_rows')) return [{ total_rows: '10' }];
    if (sql.includes('GROUP BY 1') && sql.includes('rows_24h')) {
      return [
        { prefix: 'luna.tv.bar.*', rows: '8', rows_24h: '2', rows_7d: '6', oldest_at: '2026-04-01T00:00:00Z', newest_at: '2026-07-06T00:00:00Z' },
        { prefix: 'hub_alarm', rows: '2', rows_24h: '1', rows_7d: '2', oldest_at: '2026-06-01T00:00:00Z', newest_at: '2026-07-06T00:00:00Z' },
      ];
    }
    if (sql.includes("date_trunc('day'")) return [{ day: '2026-07-06', kind: 'bar', rows: '2' }];
    if (sql.includes('MIN(created_at)') && sql.includes('WHERE') && sql.includes('RETENTION_CONDITION') === false && sql.includes('CASE WHEN event_type LIKE')) {
      return [
        { kind: 'bar', rows: '3', oldest_at: '2026-04-01T00:00:00Z', newest_at: '2026-05-01T00:00:00Z' },
        { kind: 'other', rows: '1', oldest_at: '2026-03-01T00:00:00Z', newest_at: '2026-03-01T00:00:00Z' },
      ];
    }
    if (sql.includes('to_char(date_trunc')) return [{ month: '2026-04' }];
    if (sql.includes('COUNT(*)::bigint AS rows')) return [{ rows: '3' }];
    if (sql.includes('SELECT id, event_type')) {
      archiveSelects += 1;
      if (archiveSelects > 1) return [];
      return [
        {
          id: 1,
          event_type: 'luna.tv.bar.BTCUSDT.60',
          team: 'investment',
          bot_name: 'tradingview-ws',
          severity: 'info',
          trace_id: '',
          title: 'bar',
          message: 'ok',
          tags: ['luna'],
          metadata: { close: 1 },
          feedback_score: null,
          feedback: null,
          created_at: '2026-04-01T00:00:00Z',
          updated_at: '2026-04-01T00:00:00Z',
        },
        {
          id: 2,
          event_type: 'hub_alarm',
          team: 'hub',
          bot_name: 'alarm',
          severity: 'warn',
          trace_id: '',
          title: 'alarm',
          message: 'check',
          tags: [],
          metadata: {},
          feedback_score: null,
          feedback: null,
          created_at: '2026-04-02T00:00:00Z',
          updated_at: '2026-04-02T00:00:00Z',
        },
        {
          id: 3,
          event_type: 'luna.tv.bar.ETHUSDT.60',
          team: 'investment',
          bot_name: 'tradingview-ws',
          severity: 'info',
          trace_id: '',
          title: 'bar',
          message: 'ok',
          tags: [],
          metadata: {},
          feedback_score: null,
          feedback: null,
          created_at: '2026-04-03T00:00:00Z',
          updated_at: '2026-04-03T00:00:00Z',
        },
      ];
    }
    return [];
  }
  queryReadonly.calls = calls;
  return queryReadonly;
}

async function main() {
  const policy = normalizePolicy({ barDays: 30, otherDays: 90, archiveBatchSize: 10 });
  assert.equal(classifyEventType('luna.tv.bar.BTCUSDT.60'), 'bar');
  assert.equal(classifyEventType('hub_alarm'), 'other');
  assert.equal(isRetentionCandidate({ event_type: 'luna.tv.bar.BTCUSDT.60', created_at: '2026-06-01T00:00:00Z' }, policy, FIXED_NOW), true);
  assert.equal(isRetentionCandidate({ event_type: 'luna.tv.bar.BTCUSDT.60', created_at: '2026-06-20T00:00:00Z' }, policy, FIXED_NOW), false);
  assert.equal(isRetentionCandidate({ event_type: 'hub_alarm', created_at: '2026-03-01T00:00:00Z' }, policy, FIXED_NOW), true);
  assert.deepEqual(buildRetentionCutoffs(policy, FIXED_NOW), {
    barCutoff: '2026-06-07T00:00:00.000Z',
    otherCutoff: '2026-04-08T00:00:00.000Z',
  });

  const counts = await collectRetentionCounts({ queryReadonly: makeQueryReadonly(), policy, now: FIXED_NOW });
  assert.equal(counts.candidates[0].kind, 'bar');
  assert.equal(counts.candidates[0].rows, 3);

  let runCalled = false;
  const offApply = await applyRetention({
    apply: true,
    env: {},
    policy,
    now: FIXED_NOW,
    run: async () => {
      runCalled = true;
      throw new Error('run must stay gated');
    },
  });
  assert.equal(offApply.skipped, true);
  assert.equal(offApply.reason, 'EVENT_LAKE_RETENTION_ENABLED_not_true');
  assert.equal(runCalled, false);

  let deleteBatches = 0;
  const onApply = await applyRetention({
    apply: true,
    env: { EVENT_LAKE_RETENTION_ENABLED: 'true' },
    policy: { ...policy, batchSleepMs: 1, batchSize: 2 },
    now: FIXED_NOW,
    run: async () => {
      deleteBatches += 1;
      return deleteBatches === 1 ? { rowCount: 2, rows: [{ id: 1 }, { id: 2 }] } : { rowCount: 0, rows: [] };
    },
  });
  assert.equal(onApply.deletedRows, 2);
  assert.equal(onApply.batches, 1);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'event-lake-retention-'));
  const archive = await archiveCandidates({
    queryReadonly: makeQueryReadonly(),
    policy,
    archiveDir: tmp,
    archiveMonth: '2026-04',
    now: FIXED_NOW,
  });
  assert.equal(archive.ok, true);
  assert.equal(archive.expectedRows, 3);
  assert.equal(archive.writtenRows, 3);
  const csv = zlib.gunzipSync(fs.readFileSync(archive.path)).toString('utf8');
  assert(csv.includes('luna.tv.bar.BTCUSDT.60'));
  assert(csv.startsWith('id,event_type,team'));

  const queryReadonly = makeQueryReadonly();
  const telemetry = path.join(tmp, 'telemetry.jsonl');
  const result = await runEventLakeRetention({
    queryReadonly,
    run: async () => {
      throw new Error('delete must not run in dry mode');
    },
    env: { EVENT_LAKE_RETENTION_TELEMETRY_PATH: telemetry },
    policy,
    now: FIXED_NOW,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.apply.skipped, true);
  assert(fs.existsSync(telemetry));
  assert(result.markdown.includes('Query Window Audit'));

  console.log(JSON.stringify({
    ok: true,
    smoke: 'event-lake-retention',
    checks: {
      policyFilter: true,
      applyGate: true,
      archiveCsvGzip: true,
      dryRunTelemetry: true,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: String(error?.message || error) }, null, 2));
  process.exitCode = 1;
});
