#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { classifyStaleActiveRefreshSession } from './runtime-luna-active-refresh-stale-close.ts';

export async function runLunaActiveRefreshStaleCloseSmoke() {
  const safeCompleted = classifyStaleActiveRefreshSession(
    { session_id: 'safe-completed' },
    { completed: 3 },
  );
  assert.equal(safeCompleted.action, 'safe_to_close');
  assert.equal(safeCompleted.terminalStatus, 'completed');

  const safeFailed = classifyStaleActiveRefreshSession(
    { session_id: 'safe-failed' },
    { completed: 2, failed: 1 },
  );
  assert.equal(safeFailed.action, 'safe_to_close');
  assert.equal(safeFailed.terminalStatus, 'failed');

  const running = classifyStaleActiveRefreshSession(
    { session_id: 'running-node' },
    { completed: 2, running: 1 },
  );
  assert.equal(running.action, 'review_required');
  assert.equal(running.reason, 'stale_session_has_running_nodes');

  const noNodes = classifyStaleActiveRefreshSession(
    { session_id: 'no-nodes' },
    {},
  );
  assert.equal(noNodes.action, 'review_required');
  assert.equal(noNodes.reason, 'stale_session_has_no_node_runs');

  return {
    ok: true,
    smoke: 'luna-active-refresh-stale-close',
    safeTerminalStatuses: [safeCompleted.terminalStatus, safeFailed.terminalStatus],
  };
}

async function main() {
  const result = await runLunaActiveRefreshStaleCloseSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-active-refresh-stale-close-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-active-refresh-stale-close-smoke 실패:',
  });
}
