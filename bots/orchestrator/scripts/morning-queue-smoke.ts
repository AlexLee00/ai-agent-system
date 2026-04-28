#!/usr/bin/env tsx
import assert from 'node:assert/strict';

const pgPool = require('../../../packages/core/lib/pg-pool');
const {
  buildMorningBriefing,
  deferToMorning,
  ensureMorningQueueTable,
  flushMorningQueue,
} = require('../lib/night-handler.ts');

async function main() {
  await ensureMorningQueueTable();

  const queueId = `smoke_morning_${Date.now()}`;
  await deferToMorning(queueId, 'morning queue smoke summary', ['jay', 'ska']);

  const before = await pgPool.get('claude', `
    SELECT queue_id, summary, bot_list, sent_at
    FROM morning_queue
    WHERE queue_id = $1
  `, [queueId]);
  assert.equal(before?.queue_id, queueId, 'deferred morning queue row must be stored');
  assert.equal(before?.sent_at, null, 'new morning queue row must be unsent');

  const items = await flushMorningQueue();
  assert.ok(items.some((item) => item.queue_id === queueId), 'flush must return smoke row');
  const brief = buildMorningBriefing(items.filter((item) => item.queue_id === queueId));
  assert.match(brief || '', /morning queue smoke summary/, 'briefing should include smoke summary');

  const after = await pgPool.get('claude', `
    SELECT sent_at
    FROM morning_queue
    WHERE queue_id = $1
  `, [queueId]);
  assert.ok(after?.sent_at, 'flush must mark smoke row as sent');

  await pgPool.run('claude', 'DELETE FROM morning_queue WHERE queue_id = $1', [queueId]);

  console.log('morning_queue_smoke_ok');
}

main().catch((error) => {
  console.error(`morning_queue_smoke_failed: ${error?.message || error}`);
  process.exit(1);
});
