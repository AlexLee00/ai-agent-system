#!/usr/bin/env tsx
// @ts-nocheck

import assert from 'node:assert/strict';
import { llmSelectorRoute } from '../lib/routes/llm.ts';

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

async function main() {
  const res = makeRes();
  await llmSelectorRoute({
    query: {
      key: 'orchestrator.jay.intent',
      callerTeam: 'orchestrator',
      agent: 'jay',
      taskType: 'intent_parse',
      selectorVersion: 'v3.0_oauth_4',
    },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.mode, 'read_only_selector');
  assert.equal(res.payload.selectorKey, 'orchestrator.jay.intent');
  assert.ok(Array.isArray(res.payload.chain));
  assert.ok(res.payload.chain.length > 0);
  assert.ok(res.payload.primary.provider);
  assert.ok(Object.prototype.hasOwnProperty.call(res.payload, 'effectiveTimeoutMs'));

  const disabled = makeRes();
  await llmSelectorRoute({
    query: {
      key: 'investment.aria',
      callerTeam: 'investment',
      agent: 'aria',
      selectorVersion: 'v3.0_oauth_4',
    },
  }, disabled);
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.payload.ok, true);
  assert.equal(disabled.payload.enabled, false);
  assert.deepEqual(disabled.payload.chain, []);

  const bad = makeRes();
  await llmSelectorRoute({ query: {} }, bad);
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.payload.error, 'selector_key_required');

  console.log(JSON.stringify({ ok: true, smoke: 'hub-llm-selector-route', checks: 13 }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
