#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { entryForCandidate, findRecentBloDuplicateByDigest } from './runtime-sigma-blog-vault-feed.ts';
import { applyVaultDedupePlan, buildVaultDedupePlan } from './runtime-sigma-vault-dedupe.ts';
import { buildZAxisBackfillPlan } from './runtime-sigma-zaxis-backfill.ts';
import { buildLibrarianPlan, applyLibrarianPlan } from './runtime-sigma-librarian.ts';
import { buildShortTermExpireReport } from './runtime-sigma-short-term-expire.ts';
import { buildTeamTransitionPlan } from '../vault/validation-transition.ts';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const lifecycle = require(path.join(repoRoot, 'packages/core/lib/agent-lifecycle.ts'));

function makePg({ readonlyRows = [], queryRows = [] } = {}) {
  const calls = [];
  return {
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
  };
}

function assertOnlySigmaWrites(calls) {
  const mutating = /\b(INSERT INTO|UPDATE|DELETE FROM|CREATE TABLE|ALTER TABLE|DROP TABLE|TRUNCATE)\b/i;
  const bad = calls.filter((call) => mutating.test(call.sql || '') && call.schema !== 'sigma');
  assert.equal(bad.length, 0, `non-sigma write detected: ${JSON.stringify(bad)}`);
}

async function testDedupe() {
  const groups = [{
    contentMd5: 'aaa',
    keep: { id: 3, title: 'keep', source: 'blo', created_at: '2026-07-07T00:00:00Z', meta: { source_ref: { team: 'blog' } } },
    duplicates: [
      { id: 2, title: 'dup', source: 'blo', created_at: '2026-07-06T00:00:00Z', meta: {} },
      { id: 1, title: 'dup', source: 'blo', created_at: '2026-07-05T00:00:00Z', meta: {} },
    ],
  }];
  const plan = buildVaultDedupePlan(groups);
  assert.deepEqual(plan[0].duplicateIds, [2, 1]);

  const disabled = await applyVaultDedupePlan(plan, { pg: makePg(), env: {} });
  assert.equal(disabled.skipped, true);
  assert.equal(disabled.applied, 0);

  const pg = makePg();
  const applied = await applyVaultDedupePlan(plan, { pg, env: { SIGMA_DEDUPE_ENABLED: 'true' } });
  assert.equal(applied.applied, 2);
  assert.equal(pg.calls.filter((call) => /UPDATE sigma\.vault_entries/i.test(call.sql)).length, 2);
  assert.equal(pg.calls.some((call) => /INSERT INTO sigma\.vault_audit/i.test(call.sql)), true);
  assertOnlySigmaWrites(pg.calls);
  return { groups: groups.length, duplicateRows: plan[0].duplicateCount };
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
  return { planned: plan.length, disabledGate: disabled.reason };
}

async function testShortTermRecordAndExpire() {
  const disabled = await lifecycle.recordShortTerm({
    team: 'blog',
    agent: 'writer',
    content: 'hello',
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
      meta: { source_ref: { team: 'luna', table: 'trade_journal', id: '1' } },
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

async function main() {
  const results = {
    dedupe: await testDedupe(),
    blogDuplicateGuard: await testBlogDuplicateGuard(),
    backfill: await testBackfill(),
    librarian: await testLibrarian(),
    shortTerm: await testShortTermRecordAndExpire(),
    transitionRegression: await testTransitionRegression(),
  };
  console.log(JSON.stringify({
    ok: true,
    smoke: 'sigma-als2-sgs2',
    checks: 6,
    results,
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, smoke: 'sigma-als2-sgs2', error: error?.message || String(error) }, null, 2));
  process.exit(1);
});
