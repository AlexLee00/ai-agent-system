#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { fetchPendingPosttradeCandidates } from '../shared/trade-quality-evaluator.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  await db.initSchema();
  const tradeId = 900000000 + Math.floor(Math.random() * 999999);
  const inserted = await db.get(
    `INSERT INTO investment.mapek_knowledge (event_type, payload)
     VALUES ('quality_evaluation_pending', $1)
     RETURNING id`,
    [JSON.stringify({
      smoke: true,
      source: 'posttrade_smoke',
      trade_id: tradeId,
      market: 'crypto',
      closed_at: new Date().toISOString(),
    })],
  );
  assert.ok(inserted?.id, 'quality_evaluation_pending event inserted');

  const pending = await fetchPendingPosttradeCandidates({ limit: 20, market: 'crypto' });
  const matched = pending.find((item) => Number(item.tradeId) === tradeId);
  assert.ok(matched, 'pending close event is discoverable without requiring trade_history');
  assert.equal(Number(matched.knowledgeId), Number(inserted.id), 'knowledge id preserved');

  const marked = await db.markPosttradeKnowledgeEventProcessed(inserted.id, {
    status: 'smoke_processed',
    trade_id: tradeId,
  });
  assert.equal(Number(marked), Number(inserted.id), 'pending event marked processed');

  const after = await fetchPendingPosttradeCandidates({ limit: 20, market: 'crypto' });
  assert.equal(after.some((item) => Number(item.tradeId) === tradeId), false, 'processed event no longer pending');

  return {
    ok: true,
    tradeId,
    knowledgeId: inserted.id,
    pendingBefore: pending.length,
    pendingAfter: after.length,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('posttrade-close-event-flow-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ posttrade-close-event-flow-smoke 실패:',
  });
}
