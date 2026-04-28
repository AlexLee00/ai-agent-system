#!/usr/bin/env tsx
import assert from 'node:assert/strict';

const confirmStore = require('../lib/confirm.ts');
const pgPool = require('../../../packages/core/lib/pg-pool');

async function main() {
  await confirmStore.ensurePendingConfirmsTable();

  const queueId = `smoke_queue_${Date.now()}`;
  const created = await confirmStore.createConfirm(queueId, 'pending confirms smoke');
  assert.ok(created.confirmKey.startsWith(`yes_${queueId}_`), 'confirm key should include queue id');
  assert.ok(created.rejectKey.startsWith(`no_${queueId}_`), 'reject key should include queue id');

  const confirmRow = await confirmStore.getByKey(created.confirmKey);
  assert.equal(confirmRow?.type, 'mainbot_confirm', 'confirm row should expose type');
  assert.equal(confirmRow?.payload?.action, 'approve', 'confirm row should store approve payload');
  assert.equal(confirmRow?.payload?.queueId, queueId, 'confirm payload should store queue id');

  assert.equal(await confirmStore.resolve(created.confirmKey, 'approved'), true, 'confirm key should resolve');
  assert.equal(await confirmStore.resolve(created.rejectKey, 'rejected'), true, 'reject key should resolve');
  await pgPool.run('claude', 'DELETE FROM pending_confirms WHERE queue_id = $1', [queueId]);

  console.log('pending_confirms_smoke_ok');
}

main().catch((error) => {
  console.error(`pending_confirms_smoke_failed: ${error?.message || error}`);
  process.exit(1);
});
