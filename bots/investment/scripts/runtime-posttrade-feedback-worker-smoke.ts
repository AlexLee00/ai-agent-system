#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPosttradeFeedbackWorker } from './runtime-posttrade-feedback-worker.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEARTBEAT = path.join(__dirname, '..', 'output', 'ops', 'posttrade-feedback-worker-smoke-heartbeat.json');

async function runSmoke() {
  const baseline = await runPosttradeFeedbackWorker({
    once: true,
    dryRun: true,
    limit: 2,
    market: 'all',
    heartbeatPath: HEARTBEAT,
  });
  assert.ok(baseline?.ok === false, 'worker disabled by default');
  assert.equal(baseline?.code, 'posttrade_worker_disabled');

  const forced = await runPosttradeFeedbackWorker({
    once: true,
    dryRun: true,
    force: true,
    limit: 2,
    market: 'all',
    heartbeatPath: HEARTBEAT,
  });
  assert.equal(forced?.ok, true, 'forced worker run succeeds');
  assert.ok(forced?.result && typeof forced.result === 'object', 'worker returns result payload');
  assert.ok(
    typeof forced?.result?.processed === 'number' || forced?.result?.skipped === true,
    'worker result is processed-count or skipped',
  );
  assert.ok(fs.existsSync(HEARTBEAT), 'heartbeat file exists');

  return {
    ok: true,
    baseline,
    forced: {
      ok: forced?.ok === true,
      processed: forced?.result?.processed ?? 0,
      errors: forced?.result?.errors ?? 0,
    },
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('runtime-posttrade-feedback-worker-smoke ok');
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-posttrade-feedback-worker-smoke 실패:',
  });
}
