#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyRoutingOutcomeBackfillPlan,
  buildRoutingOutcomeBackfillPlan,
  runRoutingOutcomeBackfill,
  writeRoutingOutcomeBackfillArtifacts,
} from './llm-routing-outcome-backfill.ts';

type Row = Record<string, any>;

function hubRow(id: number, createdAt: string, overrides: Row = {}): Row {
  return {
    id: String(id),
    agent: `agent-${id}`,
    caller_team: 'hub',
    prompt_chars: id * 10,
    created_at: createdAt,
    success: null,
    latency_ms: null,
    cost_usd: null,
    mode: 'shadow',
    has_signature: false,
    signature_key: null,
    routing_request_id: `request-${id}`,
    execution_model: null,
    ...overrides,
  };
}

function publicRow(id: number, hub: Row, createdAt: string, overrides: Row = {}): Row {
  return {
    id: String(id),
    agent: hub.agent,
    caller_team: hub.caller_team,
    prompt_chars: hub.prompt_chars,
    created_at: createdAt,
    success: true,
    latency_ms: 100 + id,
    duration_ms: 100 + id,
    source_cost_usd: '0.0100004',
    target_cost_usd: '0.010000',
    ...overrides,
  };
}

function buildFixture() {
  const hubs = [
    hubRow(1, '2026-07-12T00:00:00.000Z', {
      has_signature: true,
      signature_key: 'v1:test:3:3',
    }),
    hubRow(2, '2026-07-12T00:01:00.000Z'),
    hubRow(3, '2026-07-12T00:02:00.000Z'),
    hubRow(4, '2026-07-12T00:03:00.000Z', { agent: 'shared', prompt_chars: 44 }),
    hubRow(5, '2026-07-12T00:03:01.000Z', { agent: 'shared', prompt_chars: 44 }),
    hubRow(6, '2026-07-12T00:04:00.000Z'),
    hubRow(7, '2026-07-12T00:05:00.000Z'),
  ];
  const sources = [
    publicRow(101, hubs[0], '2026-07-12T00:00:01.000Z', {
      source_cost_usd: '0.1234564',
      target_cost_usd: '0.123456',
    }),
    publicRow(103, hubs[2], '2026-07-12T00:02:01.000Z'),
    publicRow(104, hubs[2], '2026-07-12T00:02:02.000Z'),
    publicRow(105, hubs[3], '2026-07-12T00:03:02.000Z'),
    publicRow(106, hubs[5], '2026-07-12T00:04:15.000Z', {
      source_cost_usd: '0.0000005',
      target_cost_usd: '0.000001',
    }),
    publicRow(107, hubs[6], '2026-07-12T00:05:01.000Z', { success: null }),
  ];
  return { hubs, sources };
}

function assertMatcherBoundaries() {
  const { hubs, sources } = buildFixture();
  const plan = buildRoutingOutcomeBackfillPlan(hubs, sources);

  assert.equal(plan.stats.population, 7);
  assert.equal(plan.stats.matched, 2);
  assert.equal(plan.stats.excluded, 5);
  assert.equal(plan.stats.exclusions.no_candidate, 1);
  assert.equal(plan.stats.exclusions.multiple_candidates, 1);
  assert.equal(plan.stats.exclusions.public_reuse, 2);
  assert.equal(plan.stats.exclusions.invalid_source_outcome, 1);
  assert.deepEqual(plan.stats.candidate_multiplicity, { '0': 1, '1': 5, '2': 1 });
  assert.deepEqual(plan.pairs.map((pair) => pair.hub_id), ['1', '6']);
  assert.equal(plan.pairs[1].delta_ms, 15_000, 'the exact 15-second boundary must be inclusive');
  assert.equal(plan.pairs[0].cost_usd, '0.123456');
  assert.equal(plan.pairs[1].cost_usd, '0.000001');
  assert.equal(plan.stats.one_to_one.distinct_hub_ids, 2);
  assert.equal(plan.stats.one_to_one.distinct_public_ids, 2);
  assert.equal(plan.stats.learning_eligibility.after_backfill, 0);
  assert.equal(plan.stats.expected_outcomes.cost_rounding_rows, 2);
  assert.match(plan.sha256, /^[a-f0-9]{64}$/);

  const reversed = buildRoutingOutcomeBackfillPlan([...hubs].reverse(), [...sources].reverse());
  assert.equal(reversed.sha256, plan.sha256, 'input order must not change the reviewed plan');

  const targetOutcomeOnly = buildRoutingOutcomeBackfillPlan(
    hubs.map((row) => row.id === '1'
      ? { ...row, success: true, latency_ms: 201, cost_usd: '0.123456' }
      : row),
    sources,
  );
  assert.equal(targetOutcomeOnly.sha256, plan.sha256, 'idempotent target outcomes must not change the plan');

  const populationDrift = buildRoutingOutcomeBackfillPlan(
    [...hubs, hubRow(8, '2026-07-12T00:06:00.000Z')],
    sources,
  );
  assert.notEqual(populationDrift.sha256, plan.sha256, 'fixed population drift must change the plan');
}

function assertMicrosecondBoundaries() {
  const exactHub = hubRow(20, '2026-07-12T00:00:00.000Z', { created_at_us: '1000000000' });
  const lateHub = hubRow(21, '2026-07-12T00:00:00.000Z', { created_at_us: '2000000000' });
  const earlyHub = hubRow(22, '2026-07-12T00:00:00.000Z', { created_at_us: '3000000000' });
  const sources = [
    publicRow(120, exactHub, '2026-07-12T00:00:15.000Z', { created_at_us: '1015000000' }),
    publicRow(121, lateHub, '2026-07-12T00:00:15.000Z', { created_at_us: '2015000001' }),
    publicRow(122, earlyHub, '2026-07-11T23:59:59.999Z', { created_at_us: '2999999999' }),
  ];
  const plan = buildRoutingOutcomeBackfillPlan([exactHub, lateHub, earlyHub], sources);
  assert.deepEqual(plan.pairs.map((pair) => pair.hub_id), ['20']);
  assert.equal(plan.pairs[0].delta_us, '15000000');
  assert.equal(plan.stats.exclusions.no_candidate, 2);
}

function assertNullLatencyIsInvalid() {
  const nullLatencyHub = hubRow(30, '2026-07-12T00:00:00.000Z');
  const nullDurationHub = hubRow(31, '2026-07-12T00:01:00.000Z');
  const sources = [
    publicRow(130, nullLatencyHub, '2026-07-12T00:00:01.000Z', {
      latency_ms: null,
      duration_ms: null,
    }),
    publicRow(131, nullDurationHub, '2026-07-12T00:01:01.000Z', {
      latency_ms: 10,
      duration_ms: null,
    }),
  ];
  const plan = buildRoutingOutcomeBackfillPlan([nullLatencyHub, nullDurationHub], sources);
  assert.equal(plan.stats.matched, 0);
  assert.equal(plan.stats.exclusions.invalid_source_outcome, 2);
}

async function assertDefaultDryRunAndDoubleGate() {
  const { hubs, sources } = buildFixture();
  let readonlyCalls = 0;
  let transactionCalls = 0;
  let artifactCalls = 0;
  const queryReadonly = async (_schema: string, sql: string) => {
    readonlyCalls += 1;
    const normalized = sql.replace(/\s+/g, ' ').trim();
    assert.match(normalized, /^SELECT\b/i);
    assert.doesNotMatch(normalized, /\b(UPDATE|INSERT|DELETE|ALTER|DROP|CREATE|TRUNCATE)\b/i);
    return sql.includes('hub.llm_auto_routing_log') ? hubs : sources;
  };
  const db = {
    transaction: async () => {
      transactionCalls += 1;
      throw new Error('dry-run must not open a write transaction');
    },
  };
  const writeArtifacts = async () => {
    artifactCalls += 1;
    return { summary: 'summary.json', pairs: 'pairs.csv', rollback_snapshot: 'rollback.json' };
  };

  const result = await runRoutingOutcomeBackfill({
    argv: [],
    queryReadonly,
    db,
    writeArtifacts,
  });
  assert.equal(result.dry_run, true);
  assert.equal(result.write_attempted, false);
  assert.equal(readonlyCalls, 2);
  assert.equal(transactionCalls, 0);
  assert.equal(artifactCalls, 1);

  readonlyCalls = 0;
  await assert.rejects(
    runRoutingOutcomeBackfill({ argv: ['--write'], queryReadonly, db, writeArtifacts }),
    /write_confirm_sha256_required/,
  );
  assert.equal(readonlyCalls, 0, 'an incomplete write gate must fail before any DB query');
  assert.equal(transactionCalls, 0);

  const confirmOnly = await runRoutingOutcomeBackfill({
    argv: [`--confirm=${result.plan_sha256}`],
    queryReadonly,
    db,
    writeArtifacts,
  });
  assert.equal(confirmOnly.dry_run, true);
  assert.equal(transactionCalls, 0);
}

function fakeDb(
  hubs: Row[],
  sources: Row[],
  events: string[] = [],
  options: { updateRowCount?: number } = {},
) {
  const states = new Map(hubs.map((row) => [String(row.id), {
    success: row.success,
    latency_ms: row.latency_ms,
    cost_usd: row.cost_usd,
  }]));
  const sqlSeen: string[] = [];
  let transactionCalls = 0;

  const db = {
    async transaction(_schema: string, callback: (client: any) => Promise<any>) {
      transactionCalls += 1;
      const before = new Map([...states].map(([id, state]) => [id, { ...state }]));
      const client = {
        async query(sql: string, params: any[] = []) {
          sqlSeen.push(sql);
          const normalized = sql.replace(/\s+/g, ' ').trim();
          if (/FOR UPDATE/i.test(normalized)) {
            return {
              rowCount: params[0].length,
              rows: params[0].map((id: string) => ({ id: String(id), ...states.get(String(id)) })),
            };
          }
          if (/UPDATE hub\.llm_auto_routing_log/i.test(normalized)) {
            events.push('update');
            const input = JSON.parse(params[0]);
            const updated = input.slice(0, options.updateRowCount ?? input.length);
            for (const row of updated) {
              states.set(String(row.id), {
                success: row.success,
                latency_ms: row.latency_ms,
                cost_usd: row.cost_usd,
              });
            }
            return { rowCount: updated.length, rows: updated.map((row: Row) => ({ id: String(row.id) })) };
          }
          if (/FROM hub\.llm_auto_routing_log/i.test(normalized)) {
            return {
              rowCount: hubs.length,
              rows: hubs.map((row) => ({ ...row, ...states.get(String(row.id)) })),
            };
          }
          if (/FROM public\.llm_routing_log/i.test(normalized)) {
            return { rowCount: sources.length, rows: sources };
          }
          return { rowCount: 0, rows: [] };
        },
      };
      try {
        const result = await callback(client);
        events.push('transaction_commit');
        return result;
      } catch (error) {
        states.clear();
        for (const [id, state] of before) states.set(id, state);
        throw error;
      }
    },
  };

  return { db, states, sqlSeen, get transactionCalls() { return transactionCalls; } };
}

async function assertApplyIsGuardedAndIdempotent() {
  const { hubs, sources } = buildFixture();
  const plan = buildRoutingOutcomeBackfillPlan(hubs, sources);
  const events: string[] = [];
  const fake = fakeDb(hubs, sources, events);
  const writeSnapshot = async () => {
    events.push('snapshot');
    return '/tmp/rollback.json';
  };

  await assert.rejects(
    applyRoutingOutcomeBackfillPlan(plan, { db: fake.db, write: true, confirm: 'wrong', writeSnapshot }),
    /write_confirm_sha256_mismatch/,
  );
  assert.equal(fake.transactionCalls, 0);

  await assert.rejects(
    applyRoutingOutcomeBackfillPlan(plan, { db: fake.db, confirm: plan.sha256, writeSnapshot }),
    /write_flag_required/,
  );
  assert.equal(fake.transactionCalls, 0, 'confirm-only direct invocation must not open a transaction');

  const tampered = {
    ...plan,
    pairs: plan.pairs.map((pair) => pair.hub_id === '1' ? { ...pair, hub_id: '999999' } : pair),
  };
  await assert.rejects(
    applyRoutingOutcomeBackfillPlan(tampered, {
      db: fake.db,
      write: true,
      confirm: plan.sha256,
      writeSnapshot,
    }),
    /supplied_plan_integrity_mismatch/,
  );
  assert.equal(fake.transactionCalls, 0);

  const metadataFake = fakeDb(hubs, sources);
  await assert.rejects(
    applyRoutingOutcomeBackfillPlan({ ...plan, window: { ...plan.window, mode: 'active' } }, {
      db: metadataFake.db,
      write: true,
      confirm: plan.sha256,
      writeSnapshot,
    }),
    /supplied_plan_integrity_mismatch/,
  );
  assert.equal(metadataFake.transactionCalls, 0);

  const first = await applyRoutingOutcomeBackfillPlan(plan, {
    db: fake.db,
    write: true,
    confirm: plan.sha256,
    writeSnapshot,
    writeReceipt: async () => {
      events.push('receipt');
      return '/tmp/receipt.json';
    },
  });
  assert.equal(first.applied, 2);
  assert.equal(first.already_applied, 0);
  assert.deepEqual(events.slice(0, 2), ['snapshot', 'update']);
  assert.deepEqual(events.slice(-2), ['transaction_commit', 'receipt']);
  assert.equal(first.after.fixed_population.all_set, 2);

  const second = await applyRoutingOutcomeBackfillPlan(plan, {
    db: fake.db,
    write: true,
    confirm: plan.sha256,
    writeSnapshot,
    writeReceipt: async () => '/tmp/receipt-2.json',
  });
  assert.equal(second.applied, 0);
  assert.equal(second.already_applied, 2);

  const updateSql = fake.sqlSeen.find((sql) => /UPDATE hub\.llm_auto_routing_log/i.test(sql));
  assert.ok(updateSql);
  assert.match(updateSql, /SET\s+success\s*=/i);
  assert.match(updateSql, /latency_ms\s*=/i);
  assert.match(updateSql, /cost_usd\s*=/i);
  assert.doesNotMatch(updateSql, /selected_provider|routing_signals|quality_score|error_code/i);
  const setClause = updateSql.match(/\bSET([\s\S]*?)\bFROM input/i)?.[1] || '';
  const setColumns = [...setClause.matchAll(/\b([a-z_][a-z0-9_]*)\s*=/gi)]
    .map((match) => match[1])
    .sort();
  assert.deepEqual(setColumns, ['cost_usd', 'latency_ms', 'success']);
  assert.match(updateSql, /target\.created_at\s*>=\s*\$2::timestamptz/i);
  assert.match(updateSql, /target\.created_at\s*<\s*\$3::timestamptz/i);
  assert.match(updateSql, /target\.mode\s*=\s*'shadow'/i);
  const lockSql = fake.sqlSeen.find((sql) => /FOR UPDATE/i.test(sql));
  assert.match(lockSql || '', /created_at\s*>=\s*\$2::timestamptz/i);
  assert.match(lockSql || '', /mode\s*=\s*'shadow'/i);
}

async function assertConflictAndPlanDriftAbort() {
  const { hubs, sources } = buildFixture();
  const plan = buildRoutingOutcomeBackfillPlan(hubs, sources);
  const conflictingHubs = hubs.map((row) => row.id === '1'
    ? { ...row, success: true, latency_ms: null, cost_usd: null }
    : row);
  const conflict = fakeDb(conflictingHubs, sources);
  await assert.rejects(
    applyRoutingOutcomeBackfillPlan(plan, {
      db: conflict.db,
      write: true,
      confirm: plan.sha256,
      writeSnapshot: async () => '/tmp/rollback.json',
    }),
    /target_outcome_conflict:1/,
  );
  assert.equal(conflict.sqlSeen.some((sql) => /UPDATE hub\.llm_auto_routing_log/i.test(sql)), false);

  const driftedSources = sources.map((row) => row.id === '101'
    ? { ...row, target_cost_usd: '0.654321' }
    : row);
  const drift = fakeDb(hubs, driftedSources);
  await assert.rejects(
    applyRoutingOutcomeBackfillPlan(plan, {
      db: drift.db,
      write: true,
      confirm: plan.sha256,
      writeSnapshot: async () => '/tmp/rollback.json',
    }),
    /backfill_plan_drift/,
  );
  assert.equal(drift.sqlSeen.some((sql) => /FOR UPDATE|UPDATE hub\.llm_auto_routing_log/i.test(sql)), false);

  const rowCountConflict = fakeDb(hubs, sources, [], { updateRowCount: 1 });
  await assert.rejects(
    applyRoutingOutcomeBackfillPlan(plan, {
      db: rowCountConflict.db,
      write: true,
      confirm: plan.sha256,
      writeSnapshot: async () => '/tmp/rollback.json',
    }),
    /target_update_count_mismatch:expected=2:actual=1/,
  );
  assert.deepEqual(rowCountConflict.states.get('1'), {
    success: null,
    latency_ms: null,
    cost_usd: null,
  }, 'a row-count mismatch must roll back the complete transaction');

  const snapshotFailure = fakeDb(hubs, sources);
  await assert.rejects(
    applyRoutingOutcomeBackfillPlan(plan, {
      db: snapshotFailure.db,
      write: true,
      confirm: plan.sha256,
      writeSnapshot: async () => { throw new Error('snapshot_failed'); },
    }),
    /snapshot_failed/,
  );
  assert.equal(snapshotFailure.sqlSeen.some((sql) => /UPDATE hub\.llm_auto_routing_log/i.test(sql)), false);

  const receiptFailure = fakeDb(hubs, sources);
  const committedWithoutReceipt = await applyRoutingOutcomeBackfillPlan(plan, {
    db: receiptFailure.db,
    write: true,
    confirm: plan.sha256,
    writeSnapshot: async () => '/tmp/rollback.json',
    writeReceipt: async () => { throw new Error('receipt_failed'); },
  });
  assert.equal(committedWithoutReceipt.committed, true);
  assert.equal(committedWithoutReceipt.ok, false);
  assert.match(committedWithoutReceipt.receipt_error, /post_commit_receipt_failed:receipt_failed/);
}

async function assertArtifacts() {
  const { hubs, sources } = buildFixture();
  const plan = buildRoutingOutcomeBackfillPlan(hubs, sources);
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-0086-'));
  try {
    const artifacts = await writeRoutingOutcomeBackfillArtifacts(plan, artifactDir);
    const secondArtifacts = await writeRoutingOutcomeBackfillArtifacts(plan, artifactDir);
    assert.deepEqual(Object.keys(artifacts).sort(), ['pairs', 'rollback_snapshot', 'summary']);
    assert.notDeepEqual(secondArtifacts, artifacts, 'each artifact run must use immutable paths');
    for (const filePath of Object.values(artifacts)) assert.equal(fs.existsSync(filePath), true);
    const summary = JSON.parse(fs.readFileSync(artifacts.summary, 'utf8'));
    const rollback = JSON.parse(fs.readFileSync(artifacts.rollback_snapshot, 'utf8'));
    const csv = fs.readFileSync(artifacts.pairs, 'utf8').trim().split('\n');
    assert.equal(summary.sample_pairs.length, 2);
    assert.equal(summary.plan_sha256, plan.sha256);
    assert.equal(rollback.rows.length, 2);
    assert.equal(csv.length, 3);
  } finally {
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
}

async function main() {
  assertMatcherBoundaries();
  assertMicrosecondBoundaries();
  assertNullLatencyIsInvalid();
  await assertDefaultDryRunAndDoubleGate();
  await assertApplyIsGuardedAndIdempotent();
  await assertConflictAndPlanDriftAbort();
  await assertArtifacts();
  console.log('llm-routing-outcome-backfill smoke: PASS');
}

main().catch((error) => {
  console.error('llm-routing-outcome-backfill smoke: FAIL');
  console.error(error);
  process.exitCode = 1;
});
