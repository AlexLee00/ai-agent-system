#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  shouldEnforcePositionSyncReadiness,
  shouldRunPositionSyncPreflight,
} from './runtime-position-runtime-autopilot.ts';

export function runPositionRuntimeAutopilotSyncPreflightSmoke() {
  assert.equal(shouldRunPositionSyncPreflight({}, false), false);
  assert.equal(shouldRunPositionSyncPreflight({}, true), false);
  assert.equal(shouldRunPositionSyncPreflight({ execute: true }, true), true);
  assert.equal(shouldRunPositionSyncPreflight({ runSyncPreflight: true }, true), true);
  assert.equal(shouldRunPositionSyncPreflight({ skipSyncPreflight: true }, true), false);
  assert.equal(shouldEnforcePositionSyncReadiness({}, true), false);
  assert.equal(shouldEnforcePositionSyncReadiness({ execute: true }, true), true);

  return {
    ok: true,
    smoke: 'position-runtime-autopilot-sync-preflight',
  };
}

async function main() {
  const result = runPositionRuntimeAutopilotSyncPreflightSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('position-runtime-autopilot-sync-preflight-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-position-runtime-autopilot-sync-preflight-smoke 실패:',
  });
}
