#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { buildSignalApprovalUpdate } from '../shared/signal-approval.ts';

const modified = buildSignalApprovalUpdate({
  status: 'approved',
  nemesis_verdict: 'modified',
  approved_at: '2026-04-23T03:00:00.000Z',
});

assert.equal(modified.status, 'approved');
assert.equal(modified.nemesisVerdict, 'modified');
assert.equal(modified.approvedAt, '2026-04-23T03:00:00.000Z');

const approved = buildSignalApprovalUpdate({});
assert.equal(approved.status, 'approved');
assert.equal(approved.nemesisVerdict, 'approved');
assert.match(approved.approvedAt, /^\d{4}-\d{2}-\d{2}T/);

const camelCase = buildSignalApprovalUpdate({
  nemesisVerdict: 'approved',
  approvedAt: '2026-04-23T04:00:00.000Z',
});
assert.equal(camelCase.nemesisVerdict, 'approved');
assert.equal(camelCase.approvedAt, '2026-04-23T04:00:00.000Z');

console.log('signal approval persist smoke ok');
