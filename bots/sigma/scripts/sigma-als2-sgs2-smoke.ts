#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { entryForCandidate, findRecentBloDuplicateByDigest } from './runtime-sigma-blog-vault-feed.ts';
import {
  applyVaultDedupePlan,
  buildVaultDedupeReport,
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
const VAULT_AUDIT_ACTION_CHECK_FIXTURE = new Set(['created', 'classified', 'moved', 'archived', 'tagged']);

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

function makeDedupeApplyPg(seedRows = [], { duplicateUpdateRowCount = null } = {}) {
  const rows = new Map(seedRows.map((row) => [String(row.id), structuredClone(row)]));
  const calls = [];
  const audits = [];
  const pg = {
    rows,
    calls,
    audits,
    activeCount() {
      return [...rows.values()].filter((row) => !row.meta?.merged_into).length;
    },
    async transaction(schema, callback) {
      calls.push({ kind: 'transaction', schema, sql: 'BEGIN', params: [] });
      const snapshot = [...rows.entries()].map(([id, row]) => [id, structuredClone(row)]);
      try {
        return await callback({
          async query(sql, params = []) {
            calls.push({ kind: 'transactionQuery', schema, sql, params });
            if (/pg_advisory_xact_lock/i.test(sql)) return { rows: [], rowCount: 1 };
            if (/SELECT id, title, type, content, source, file_path, meta, embedding/i.test(sql)) {
              const ids = new Set((params[0] || []).map(String));
              return {
                rows: [...rows.values()].filter((row) => ids.has(String(row.id)) && !row.meta?.merged_into),
                rowCount: ids.size,
              };
            }
            if (/SET meta = \$2::jsonb,[\s\S]*embedding = COALESCE/i.test(sql)) {
              const keep = rows.get(String(params[0]));
              if (!keep || keep.meta?.merged_into) return { rows: [], rowCount: 0 };
              keep.meta = JSON.parse(params[1]);
              const embeddingSource = rows.get(String(params[2]));
              if (!keep.embedding && embeddingSource?.embedding) keep.embedding = embeddingSource.embedding;
              return { rows: [{ id: keep.id }], rowCount: 1 };
            }
            if (/SET meta = COALESCE\(meta/i.test(sql) && /merged_into/i.test(sql)) {
              const duplicateIds = (params[2] || []).map(String);
              let rowCount = 0;
              for (const id of duplicateIds) {
                const row = rows.get(id);
                if (!row || row.meta?.merged_into) continue;
                row.meta = {
                  ...(row.meta || {}),
                  merged_into: String(params[0]),
                  merged_reason: 'sigma_vault_dedupe',
                  dedupe_md5: params[1],
                };
                rowCount += 1;
              }
              return {
                rows: [],
                rowCount: duplicateUpdateRowCount == null ? rowCount : duplicateUpdateRowCount,
              };
            }
            if (/INSERT INTO sigma\.vault_audit/i.test(sql)) {
              const action = String(sql).match(/SELECT duplicate_id,\s*'([^']+)'/i)?.[1] || '';
              if (!VAULT_AUDIT_ACTION_CHECK_FIXTURE.has(action)) {
                throw new Error('violates check constraint "vault_audit_action_check"');
              }
              for (const entryId of params[0] || []) audits.push({ entryId, action, reasoning: params[1] });
              return { rows: [], rowCount: (params[0] || []).length };
            }
            throw new Error(`unexpected dedupe apply query: ${String(sql).replace(/\s+/g, ' ').trim().slice(0, 160)}`);
          },
        });
      } catch (error) {
        rows.clear();
        for (const [id, row] of snapshot) rows.set(id, row);
        throw error;
      }
    },
  };
  return pg;
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

  const applySeedRows = [
    {
      ...rows[0],
      embedding: null,
      meta: {
        keep_only: 'preserved',
        source_ref: { team: 'docs', table: 'lessons', id: '1' },
      },
    },
    {
      ...rows[2],
      embedding: '[0.3,0.4]',
      meta: {
        source_ref: { team: 'blo', table: 'posts', id: '3' },
        source_refs: [{ team: 'archive', table: 'posts', id: '3a' }],
      },
    },
    {
      ...rows[1],
      embedding: '[0.1,0.2]',
      meta: { source_ref: { team: 'blo', table: 'posts', id: '2' } },
    },
  ];
  const applyPg = makeDedupeApplyPg(applySeedRows);
  const activeBefore = applyPg.activeCount();
  const keepBefore = structuredClone(applyPg.rows.get(rows[0].id));
  const applied = await applyVaultDedupePlan(plan, { pg: applyPg, write: true, confirm: true });
  assert.equal(applied.applied, 2);
  assert.equal(applyPg.activeCount(), activeBefore - 2);
  assert.equal([...applyPg.rows.values()].filter((row) => row.meta?.merged_into === rows[0].id).length, 2);
  const keepAfter = applyPg.rows.get(rows[0].id);
  assert.equal(keepAfter.title, keepBefore.title);
  assert.equal(keepAfter.content, keepBefore.content);
  assert.equal(keepAfter.source, keepBefore.source);
  assert.equal(keepAfter.meta.keep_only, 'preserved');
  assert.deepEqual(keepAfter.meta.source_ref, keepBefore.meta.source_ref);
  assert.deepEqual(keepAfter.meta.source_refs, [
    { team: 'docs', table: 'lessons', id: '1' },
    { team: 'blo', table: 'posts', id: '3' },
    { team: 'archive', table: 'posts', id: '3a' },
    { team: 'blo', table: 'posts', id: '2' },
  ]);
  assert.equal(keepAfter.embedding, '[0.3,0.4]');
  assert.equal(applyPg.audits.length, 2);
  assert.equal(applyPg.audits.every((audit) => audit.action === 'tagged'), true);
  assert.match(applyPg.audits[0].reasoning, /sigma_vault_dedupe: merged_into=/);
  const reapplied = await applyVaultDedupePlan(plan, { pg: applyPg, write: true, confirm: true });
  assert.equal(reapplied.applied, 0);
  assert.equal(applyPg.activeCount(), activeBefore - 2);
  assertOnlySigmaWrites(applyPg.calls);

  const conflictPg = makeDedupeApplyPg(applySeedRows, { duplicateUpdateRowCount: 1 });
  const rollbackBefore = structuredClone([...conflictPg.rows.values()]);
  await assert.rejects(
    applyVaultDedupePlan(plan, { pg: conflictPg, write: true, confirm: true }),
    /dedupe_concurrency_conflict/
  );
  assert.deepEqual([...conflictPg.rows.values()], rollbackBefore, 'row-count conflicts must roll back the whole group');
  assertOnlySigmaWrites(conflictPg.calls);

  const bulkKeepId = '00000000-0000-4000-8000-999999999999';
  const bulkDuplicates = Array.from({ length: 297 }, (_, index) => ({
    id: `00000000-0000-4000-8001-${String(index + 1).padStart(12, '0')}`,
    meta: {},
    embedding: null,
  }));
  const bulkPg = makeDedupeApplyPg([
    { id: bulkKeepId, meta: { keep_only: 'preserved' }, embedding: '[0.9,1.0]' },
    ...bulkDuplicates,
  ]);
  const bulkPlan = [{
    contentMd5: 'bulk-297-invariant',
    keepId: bulkKeepId,
    duplicateIds: bulkDuplicates.map((row) => row.id),
  }];
  const bulkActiveBefore = bulkPg.activeCount();
  const bulkApplied = await applyVaultDedupePlan(bulkPlan, { pg: bulkPg, write: true, confirm: true });
  assert.equal(bulkApplied.applied, 297);
  assert.equal(bulkPg.activeCount(), bulkActiveBefore - 297);
  assert.equal([...bulkPg.rows.values()].filter((row) => row.meta?.merged_into === bulkKeepId).length, 297);
  const bulkReapplied = await applyVaultDedupePlan(bulkPlan, { pg: bulkPg, write: true, confirm: true });
  assert.equal(bulkReapplied.applied, 0);
  assert.equal(bulkPg.rows.get(bulkKeepId).meta.keep_only, 'preserved');
  assertOnlySigmaWrites(bulkPg.calls);

  const limitRows = [
    ...rows.slice(0, 2),
    { ...rows[0], id: '00000000-0000-4000-8000-000000000011', title: 'Group 2', content: 'same' },
    { ...rows[1], id: '00000000-0000-4000-8000-000000000012', title: ' Group 2 ', content: 'same' },
    { ...rows[0], id: '00000000-0000-4000-8000-000000000021', title: 'Group 3', content: 'same' },
    { ...rows[1], id: '00000000-0000-4000-8000-000000000022', title: ' Group 3 ', content: 'same' },
  ];
  const limitedReport = await buildVaultDedupeReport({ rows: limitRows, limit: 1 });
  assert.equal(limitedReport.counts.plannedGroups, 3, 'limit must not truncate executable groups');
  assert.equal(limitedReport.plan.length, 1, 'limit may only cap the displayed plan sample');
  return {
    groups: inventory.normalized.groups,
    duplicateRows: plan[0].duplicateCount,
    nearDuplicatesExcluded: true,
    invariantApplied: applied.applied,
    idempotentReapply: reapplied.applied,
    conflictRolledBack: true,
    fullInvariantApplied: bulkApplied.applied,
    fullInvariantMarked: 297,
    fullInvariantReapply: bulkReapplied.applied,
    auditActionCheck: 'tagged',
    fullPlanWithDisplayLimit: limitedReport.counts.plannedGroups,
  };
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
