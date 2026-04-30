#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { classifyAgentMessageBusHygiene } from '../shared/luna-operational-closure-pack.ts';

export async function runAgentMessageBusHygieneClassifierSmoke() {
  const classified = classifyAgentMessageBusHygiene({
    ok: true,
    before: {
      staleCount: 12,
      rows: [
        { to_agent: 'all', message_type: 'broadcast', stale_count: '5' },
        { to_agent: 'hermes', message_type: 'query', stale_count: '4' },
        { to_agent: 'argos', message_type: 'query', stale_count: '3' },
      ],
    },
  });
  assert.equal(classified.reviewRequired, 9);
  assert.equal(classified.safeExpire, 3);
  assert.equal(classified.blocked, 0);
  assert.equal(classified.rows.find((row) => row.to_agent === 'all').hygieneClass, 'review_required');
  assert.equal(classified.rows.find((row) => row.to_agent === 'argos').hygieneClass, 'safe_expire');

  const failed = classifyAgentMessageBusHygiene({ ok: false, staleCount: 7 });
  assert.equal(failed.ok, false);
  assert.equal(failed.blocked, 7);
  return { ok: true, classified, failed };
}

async function main() {
  const result = await runAgentMessageBusHygieneClassifierSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('agent message bus hygiene classifier smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ agent message bus hygiene classifier smoke 실패:',
  });
}
