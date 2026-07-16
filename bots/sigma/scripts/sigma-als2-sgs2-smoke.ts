#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { entryForCandidate, findRecentBloDuplicateByDigest } from './runtime-sigma-blog-vault-feed.ts';
import {
  applyVaultDedupePlan,
  buildVaultDedupePlan,
  buildVaultDuplicateInventory,
} from './runtime-sigma-vault-dedupe.ts';
import { buildZAxisBackfillPlan } from './runtime-sigma-zaxis-backfill.ts';
import { buildLibrarianPlan, applyLibrarianPlan, fetchLibrarianCandidates } from './runtime-sigma-librarian.ts';
import { buildShortTermExpireReport } from './runtime-sigma-short-term-expire.ts';
import {
  buildTeamTransitionPlan,
  fetchDuePredictionRows,
  fetchEvidenceRowsForDue,
  fetchPredictionLedgerRows,
  fetchVaultRowsForSourceRefs,
} from '../vault/validation-transition.ts';
import { fetchVaultTierReport } from '../vault/vault-tiering.ts';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const lifecycle = require(path.join(repoRoot, 'packages/core/lib/agent-lifecycle.ts'));

function makePg({ readonlyRows = [], queryRows = [], updateRowCount = null } = {}) {
  const calls = [];
  const pg = {
    calls,
    async queryReadonly(schema, sql, params = []) {
      calls.push({ kind: 'queryReadonly', schema, sql, params });
      return typeof readonlyRows === 'function' ? readonlyRows(schema, sql, params) : readonlyRows;
    },
    async query(schema, sql, params = []) {
      calls.push({ kind: 'query', schema, sql, params });
      return typeof queryRows === 'function' ? queryRows(schema, sql, params) : queryRows;
    },
    async run(schema, sql, params = []) {
      calls.push({ kind: 'run', schema, sql, params });
      return { rowCount: Array.isArray(params?.[0]) ? params[0].length : 1, rows: [] };
    },
    async transaction(schema, callback) {
      calls.push({ kind: 'transaction', schema, sql: 'BEGIN', params: [] });
      const client = {
        async query(sql, params = []) {
          calls.push({ kind: 'transactionQuery', schema, sql, params });
          if (/UPDATE sigma\.vault_entries/i.test(sql)) {
            const expected = Array.isArray(params?.[2]) ? params[2].length : 0;
            return { rowCount: updateRowCount == null ? expected : updateRowCount, rows: [] };
          }
          return { rowCount: 1, rows: [] };
        },
      };
      return callback(client);
    },
  };
  return pg;
}

function assertOnlySigmaWrites(calls) {
  const mutating = /\b(INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE|ALTER TABLE|DROP TABLE|TRUNCATE)\b/i;
  const bad = calls.filter((call) => mutating.test(call.sql || '') && call.schema !== 'sigma');
  assert.equal(bad.length, 0, `non-sigma write detected: ${JSON.stringify(bad)}`);
}

async function testDedupe() {
  const rows = [
    {
      id: '00000000-0000-4000-8000-000000000001',
      title: 'Lesson',
      type: 'library_record',
      content: 'line one\nline two',
      source: 'docs',
      created_at: '2026-07-05T00:00:00Z',
      abstraction_level: 'L2',
      time_stage: 'pattern',
      validation_state: 'validated',
      prediction_state: 'resolved',
      has_embedding: true,
      meta: { source_ref: { team: 'docs', table: 'lessons', id: '1' } },
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      title: ' Lesson ',
      type: 'library_record',
      content: 'line one   line two',
      source: 'blo',
      created_at: '2026-07-07T00:00:00Z',
      validation_state: 'unverified',
      meta: {},
    },
    {
      id: '00000000-0000-4000-8000-000000000003',
      title: ' Lesson ',
      type: 'library_record',
      content: 'line one   line two',
      source: 'blo',
      created_at: '2026-07-06T00:00:00Z',
      validation_state: 'observed',
      meta: {},
    },
    {
      id: '00000000-0000-4000-8000-000000000004',
      title: 'Lesson',
      type: 'library_record',
      content: 'line one line two.',
      source: 'docs',
      created_at: '2026-07-08T00:00:00Z',
      validation_state: 'validated',
      meta: {},
    },
  ];
  const inventory = buildVaultDuplicateInventory(rows);
  assert.equal(inventory.exact.groups, 1);
  assert.equal(inventory.normalized.groups, 1);
  assert.equal(inventory.normalized.duplicateRows, 2);
  assert.equal(inventory.normalizedGroups[0].keep.id, rows[0].id, 'strongest coordinates must win before recency');
  assert.equal(inventory.normalizedGroups[0].duplicates.some((row) => row.id === rows[3].id), false, 'near duplicate must be excluded');
  assert.equal(inventory.byTier.knowledge.totalRows, 4);
  assert.equal(inventory.bySource.blo.normalizedDuplicateRows, 2);

  const emptyInventory = buildVaultDuplicateInventory([rows[0], rows[3]]);
  assert.equal(emptyInventory.normalized.groups, 0);
  assert.equal(emptyInventory.normalized.duplicateRows, 0);

  const plan = buildVaultDedupePlan(inventory.normalizedGroups);
  assert.deepEqual(plan[0].duplicateIds, [rows[2].id, rows[1].id]);
  assert.deepEqual(plan[0].transferPlan, {
    embedding: 'fill_keep_only_when_missing',
    sourceRefs: 'union_into_keep_meta.source_refs',
    knowledgeGraphRefs: 'redirect_duplicate_entry_ids_to_keep_id',
  });

  const disabled = await applyVaultDedupePlan(plan, { pg: makePg(), write: false, confirm: false });
  assert.equal(disabled.skipped, true);
  assert.equal(disabled.applied, 0);

  const unconfirmed = await applyVaultDedupePlan(plan, { pg: makePg(), write: true, confirm: false });
  assert.equal(unconfirmed.reason, 'write_confirm_required');

  const pg = makePg();
  const blocked = await applyVaultDedupePlan(plan, { pg, write: true, confirm: true });
  assert.equal(blocked.applied, 0);
  assert.equal(blocked.skipped, true);
  assert.equal(blocked.reason, 'reference_transfer_not_implemented');
  assert.equal(pg.calls.length, 0, 'dedupe must not hide rows before references are transferred');
  assertOnlySigmaWrites(pg.calls);
  return { groups: inventory.normalized.groups, duplicateRows: plan[0].duplicateCount, nearDuplicatesExcluded: true };
}

async function testBlogDuplicateGuard() {
  const candidate = {
    title: '[blog_post] same',
    type: 'blog_post',
    content: 'same content',
    tags: ['blog'],
    filePath: 'library/blo/post/1',
    meta: { sourceTable: 'blog.posts', sourceId: '1' },
  };
  const entry = entryForCandidate(candidate);
  assert.ok(entry.meta.sigmaContentMd5, 'content md5 should be stored in meta');
  const duplicate = await findRecentBloDuplicateByDigest(entry.meta.sigmaContentMd5, {
    pool: makePg({ queryRows: [{ id: 99, title: 'existing' }] }),
  });
  assert.equal(duplicate.id, 99);
  return { digestStored: true, duplicateDetected: true };
}

async function testBackfill() {
  const now = new Date('2026-07-07T00:00:00Z');
  const plan = buildZAxisBackfillPlan([
    { id: 1, title: 'fresh', created_at: '2026-07-05T00:00:00Z', meta: {} },
    { id: 2, title: 'digest', created_at: '2026-06-20T00:00:00Z', meta: {} },
    { id: 3, title: 'old', created_at: '2026-05-01T00:00:00Z', meta: {} },
  ], { now });
  assert.equal(plan[0].patch.time_stage, 'raw');
  assert.equal(plan[1].patch.time_stage, 'digest');
  assert.equal(plan[2].patch.time_stage, 'dormant');
  assert.equal(plan.every((item) => item.patch.abstraction_level === 'L0'), true);
  return { distribution: plan.map((item) => item.patch.time_stage) };
}

async function testLibrarian() {
  const plan = buildLibrarianPlan({
    decayRows: [
      { id: 1, title: 'raw old', current_time_stage: 'raw' },
      { id: 2, title: 'pattern old', current_time_stage: 'pattern' },
    ],
    recallRows: [
      { id: 3, title: 'forgotten hit', current_time_stage: 'forgotten' },
    ],
  });
  assert.deepEqual(plan.map((item) => `${item.transition}:${item.from}->${item.to}`), [
    'decay:raw->digest',
    'decay:pattern->dormant',
    'recall:forgotten->dormant',
  ]);
  const disabled = await applyLibrarianPlan(plan, { pg: makePg(), env: {} });
  assert.equal(disabled.skipped, true);
  const pg = makePg();
  const applied = await applyLibrarianPlan(plan, { pg, env: { SIGMA_LIBRARIAN_ENABLED: 'true' } });
  assert.equal(applied.applied, 3);
  const updates = pg.calls.filter((call) => /UPDATE sigma\.vault_entries/i.test(call.sql));
  assert.equal(updates.length, 3);
  assert.equal(updates.every((call) => /meta->>'merged_into'\) IS NULL/.test(call.sql)), true);
  assert.equal(updates.every((call) => /jsonb_set/.test(call.sql)), true);
  return { planned: plan.length, disabledGate: disabled.reason, mergedMarkerPreserved: true };
}

async function testShortTermRecordAndExpire() {
  const disabled = await lifecycle.recordShortTerm({
    team: 'blog',
    agent: 'writer',
    content: 'hello',
    env: {},
    pgPool: makePg(),
  });
  assert.equal(disabled.skipped, true);

  const pg = makePg({ queryRows: [{ id: 7, expires_at: '2026-07-08T00:00:00Z' }] });
  const recorded = await lifecycle.recordShortTerm({
    team: 'blog',
    agent: 'writer',
    content: 'hello',
    context: { source: 'smoke' },
    ttlDays: 0.05,
    env: { SIGMA_SHORT_TERM_ENABLED: 'true' },
    pgPool: pg,
  });
  assert.equal(recorded.ok, true);
  assert.equal(recorded.id, 7);
  assert.equal(pg.calls.some((call) => /INSERT INTO sigma\.agent_short_term_memory/i.test(call.sql)), true);

  const expiredPg = makePg({
    readonlyRows: [{ id: 7, team: 'blog', agent_name: 'writer', expires_at: '2026-07-06T00:00:00Z' }],
  });
  const report = await buildShortTermExpireReport({
    apply: true,
    queryReadonly: expiredPg.queryReadonly.bind(expiredPg),
    pg: expiredPg,
  });
  assert.equal(report.counts.expired, 1);
  assert.equal(report.counts.deleted, 1);
  assertOnlySigmaWrites([...pg.calls, ...expiredPg.calls]);
  return { recorded: recorded.id, deleted: report.counts.deleted };
}

async function testTransitionRegression() {
  const plan = buildTeamTransitionPlan({
    vaultRows: [{
      id: 1,
      title: 'validated lesson',
      validation_state: 'unverified',
      meta: {
        source_ref: { team: 'docs', table: 'lessons', id: '1' },
        source_refs: [
          { team: 'docs', table: 'lessons', id: '1' },
          { team: 'luna', table: 'trade_journal', id: '1' },
        ],
      },
    }],
    triggers: [{
      team: 'luna',
      table: 'trade_journal',
      id: '1',
      polarity: 'positive',
      reason: 'smoke',
    }],
  });
  assert.equal(plan[0].matched, true);
  assert.equal(plan[0].apply, true);
  assert.equal(plan[0].nextCoords.validation_state, 'validated');
  return { matched: plan.filter((item) => item.matched).length };
}

async function testMergedConsumerFilters() {
  const pg = makePg();
  await fetchLibrarianCandidates({ queryReadonly: pg.queryReadonly.bind(pg) });
  await fetchVaultTierReport({ queryReadonly: pg.queryReadonly.bind(pg) });
  await fetchVaultRowsForSourceRefs({
    sourceRefs: [{ team: 'luna', table: 'trade_journal', id: '1' }],
    queryReadonly: pg.queryReadonly.bind(pg),
  });
  await fetchDuePredictionRows({ queryReadonly: pg.queryReadonly.bind(pg) });
  await fetchEvidenceRowsForDue({ dueRows: [{ id: 1 }], queryReadonly: pg.queryReadonly.bind(pg) });
  await fetchPredictionLedgerRows({ queryReadonly: pg.queryReadonly.bind(pg) });
  const vaultReads = pg.calls.filter((call) => /FROM sigma\.vault_entries/i.test(call.sql));
  assert.ok(vaultReads.length >= 6);
  for (const call of vaultReads) assert.match(call.sql, /meta->>'merged_into'\) IS NULL/);
  const sourceRefRead = vaultReads.find((call) => /source_ref/.test(call.sql));
  assert.match(sourceRefRead.sql, /jsonb_array_elements/, 'source-ref lookup must include preserved aliases');
  return { checkedQueries: vaultReads.length };
}

async function main() {
  const results = {
    dedupe: await testDedupe(),
    blogDuplicateGuard: await testBlogDuplicateGuard(),
    backfill: await testBackfill(),
    librarian: await testLibrarian(),
    shortTerm: await testShortTermRecordAndExpire(),
    transitionRegression: await testTransitionRegression(),
    mergedConsumerFilters: await testMergedConsumerFilters(),
  };
  console.log(JSON.stringify({
    ok: true,
    smoke: 'sigma-als2-sgs2',
    checks: 7,
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, smoke: 'sigma-als2-sgs2', error: error?.message || String(error) }, null, 2));
  process.exit(1);
});
