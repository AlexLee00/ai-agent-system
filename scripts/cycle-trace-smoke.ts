#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCycleTrace, getCurrentCycleTrace, withTrace } from '../packages/core/lib/cycle-trace.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function main() {
  const trace = createCycleTrace('smoke');
  assert.match(trace.traceId, /^[a-f0-9]{32}$/);
  assert.equal(trace.trace_id, trace.traceId);
  assert.equal(trace.cycle_id, trace.cycleId);
  assert.ok(trace.cycleId.startsWith('smoke:'));

  await withTrace(trace, async () => {
    const current = getCurrentCycleTrace();
    assert.equal(current?.traceId, trace.traceId);
    assert.equal(current?.cycleId, trace.cycleId);
  });
  assert.equal(getCurrentCycleTrace(), null);

  const hubClient = fs.readFileSync(path.join(root, 'packages/core/lib/hub-client.ts'), 'utf8');
  assert.match(hubClient, /getCurrentTracePropagation/);
  assert.match(hubClient, /cycleId/);

  const llmRoute = fs.readFileSync(path.join(root, 'bots/hub/lib/routes/llm.ts'), 'utf8');
  assert.match(llmRoute, /trace_id/);
  assert.match(llmRoute, /routingLogTraceColumnsExist/);

  const mcp = fs.readFileSync(path.join(root, 'bots/hub/mcp/hub-ops-mcp/src/server.ts'), 'utf8');
  assert.match(mcp, /hub-trace/);
  assert.doesNotMatch(mcp, /DELETE\s+FROM|UPDATE\s+.+SET|INSERT\s+INTO/i);

  console.log(JSON.stringify({ ok: true, checks: 7 }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
