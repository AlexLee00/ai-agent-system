#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
const {
  buildLockedRollbackSnapshotPath,
  defineWriteCountEvidence,
  matchesWriteActionConfirm,
  stableWritePlanJson,
  writePlanSha256,
} = require('../lib/write-action-confirm.js');

const left = { z: 1, nested: { b: 2, a: 1 }, list: [{ y: 2, x: 1 }] };
const right = { list: [{ x: 1, y: 2 }], nested: { a: 1, b: 2 }, z: 1 };
assert.equal(stableWritePlanJson(left), stableWritePlanJson(right));
assert.equal(writePlanSha256(left), writePlanSha256(right));

const insertionOrdered = { z: 1, a: 2 };
const expectedLegacySha = crypto.createHash('sha256')
  .update(JSON.stringify(insertionOrdered))
  .digest('hex');
assert.equal(writePlanSha256(insertionOrdered, JSON.stringify), expectedLegacySha);
assert.throws(() => writePlanSha256({ value: Number.NaN }), /write_plan_non_finite_number/);
assert.throws(() => writePlanSha256({ value: undefined }), /write_plan_unsupported_value/);
assert.throws(() => writePlanSha256(new Map([['value', 1]])), /write_plan_non_plain_object/);
assert.throws(() => writePlanSha256({ toJSON() { return this; } }), /write_plan_circular_reference/);
assert.throws(() => writePlanSha256(Array(1)), /write_plan_sparse_array/);

assert.equal(matchesWriteActionConfirm(expectedLegacySha, expectedLegacySha), true);
assert.equal(matchesWriteActionConfirm(` ${expectedLegacySha}`, expectedLegacySha), false);
assert.equal(matchesWriteActionConfirm(expectedLegacySha.toUpperCase(), expectedLegacySha), false);
assert.equal(matchesWriteActionConfirm(123, expectedLegacySha), false);
assert.equal(matchesWriteActionConfirm('', ''), false);

assert.equal(
  buildLockedRollbackSnapshotPath({
    artifactDir: '/tmp/task-0094',
    actionPrefix: 'TASK-0086-routing-outcome-backfill',
    planSha256: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    runId: '20260723031000000-fixture',
  }),
  '/tmp/task-0094/TASK-0086-routing-outcome-backfill-abcdef123456-apply-20260723031000000-fixture.locked-rollback-snapshot.json',
);

const before = { pending: 2, applied: 0 };
const after = { pending: 0, applied: 2 };
assert.deepEqual(defineWriteCountEvidence(before, after), { before, after });

console.log('write-action-confirm smoke: PASS');
