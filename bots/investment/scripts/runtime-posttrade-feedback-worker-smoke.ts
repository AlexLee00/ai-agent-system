#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runPosttradeFeedbackWorker } from './runtime-posttrade-feedback-worker.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HEARTBEAT = path.join(os.tmpdir(), 'posttrade-feedback-worker-smoke-heartbeat.json');

async function runSmoke() {
  const previous = process.env.LUNA_POSTTRADE_WORKER_ENABLED;
  process.env.LUNA_POSTTRADE_WORKER_ENABLED = 'false';
  const baseline = await runPosttradeFeedbackWorker({
    once: true,
    dryRun: true,
    limit: 2,
    market: 'all',
    heartbeatPath: HEARTBEAT,
  });
  if (previous === undefined) delete process.env.LUNA_POSTTRADE_WORKER_ENABLED;
  else process.env.LUNA_POSTTRADE_WORKER_ENABLED = previous;
  assert.ok(baseline?.ok === false, 'worker disabled by default');
  assert.equal(baseline?.code, 'posttrade_worker_disabled');

  const previousAutoApply = process.env.LUNA_PARAMETER_AUTO_APPLY;
  process.env.LUNA_PARAMETER_AUTO_APPLY = 'true';
  const forced = await runPosttradeFeedbackWorker({
    once: true,
    dryRun: true,
    force: true,
    limit: 2,
    market: 'all',
    heartbeatPath: HEARTBEAT,
  });
  if (previousAutoApply === undefined) delete process.env.LUNA_PARAMETER_AUTO_APPLY;
  else process.env.LUNA_PARAMETER_AUTO_APPLY = previousAutoApply;
  assert.equal(forced?.ok, true, 'forced worker run succeeds');
  assert.ok(forced?.result && typeof forced.result === 'object', 'worker returns result payload');
  assert.ok(
    typeof forced?.result?.processed === 'number' || forced?.result?.skipped === true,
    'worker result is processed-count or skipped',
  );
  assert.ok(forced?.learning && typeof forced.learning === 'object', 'worker returns learning payload');
  assert.ok(Number.isFinite(Number(forced?.learning?.days || 0)), 'learning cycle days returned');
  assert.ok(forced?.learning?.skillExtraction, 'skill extraction step returned');
  assert.ok(forced?.learning?.dashboard, 'dashboard step returned');
  assert.ok(forced?.learning?.actionAutoApply, 'action auto-apply step returned');
  assert.equal(forced?.learning?.actionAutoApply?.code, 'posttrade_action_auto_apply_dry_run');
  assert.ok(fs.existsSync(HEARTBEAT), 'heartbeat file exists');

  return {
    ok: true,
    baseline,
    forced: {
      ok: forced?.ok === true,
      processed: forced?.result?.processed ?? 0,
      errors: forced?.result?.errors ?? 0,
      learningDays: forced?.learning?.days ?? null,
      skillExtractionOk: forced?.learning?.skillExtraction?.ok === true,
      dashboardOk: forced?.learning?.dashboard?.ok === true,
      actionAutoApplyCode: forced?.learning?.actionAutoApply?.code || null,
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
