#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildOpsSchedulerPlan,
  getOpsSchedulerJobs,
  resolveOnlyJobArg,
  runOpsScheduler,
  seedOpsSchedulerState,
} from './runtime-luna-ops-scheduler.ts';

export async function runLunaOpsSchedulerSmoke() {
  const jobs = getOpsSchedulerJobs();
  assert.equal(jobs.length, 12);
  assert.equal(jobs.some((job) => job.name === 'discovery_candidate_refresh'), true);
  assert.equal(jobs.some((job) => job.name === 'market_cycle_crypto'), true);
  assert.equal(jobs.some((job) => job.name === 'market_cycle_domestic'), true);
  assert.equal(jobs.some((job) => job.name === 'market_cycle_overseas'), true);
  assert.equal(jobs.some((job) => job.name === 'discovery_funnel_report'), true);

  const now = new Date('2026-05-04T02:00:00+09:00');
  const emptyPlan = buildOpsSchedulerPlan({ now, state: { jobs: {} }, jobs });
  assert.equal(emptyPlan.due, 12);

  const recentState = {
    jobs: Object.fromEntries(jobs.map((job) => [job.name, { lastRunAt: now.toISOString() }])),
  };
  const recentPlan = buildOpsSchedulerPlan({ now, state: recentState, jobs });
  assert.equal(recentPlan.due, 0);

  const forced = buildOpsSchedulerPlan({ now, state: recentState, jobs, onlyJob: 'guardrails_hourly', force: true });
  assert.equal(forced.total, 1);
  assert.equal(forced.due, 1);
  assert.equal(resolveOnlyJobArg(['--only-job=market_cycle_crypto']), 'market_cycle_crypto');
  assert.equal(resolveOnlyJobArg(['--job=market_cycle_domestic']), 'market_cycle_domestic');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-ops-scheduler-'));
  const statePath = path.join(tmp, 'state.json');
  const lockPath = path.join(tmp, 'lock.json');
  const calls = [];
  const executed = await runOpsScheduler({
    now,
    statePath,
    lockPath,
    jobs,
    runner: (job) => {
      calls.push(job.name);
      return { ok: true, status: 0, stdoutTail: 'ok', stderrTail: '' };
    },
  });
  assert.equal(executed.ok, true);
  assert.equal(calls.length, 12);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(statePath, 'utf8')).jobs).length, 12);

  const seedPath = path.join(tmp, 'seeded-state.json');
  const seeded = seedOpsSchedulerState({ now, statePath: seedPath, jobs });
  assert.equal(seeded.ok, true);
  const seededPlan = buildOpsSchedulerPlan({
    now,
    jobs,
    state: JSON.parse(fs.readFileSync(seedPath, 'utf8')),
  });
  assert.equal(seededPlan.due, 0);

  fs.writeFileSync(lockPath, JSON.stringify({ lockedAt: now.toISOString(), pid: 999999 }));
  const locked = await runOpsScheduler({ now, statePath, lockPath, jobs });
  assert.equal(locked.ok, false);
  assert.equal(locked.status, 'locked');

  return {
    ok: true,
    jobs: jobs.map((job) => job.name),
    emptyDue: emptyPlan.due,
    forcedDue: forced.due,
    executed: calls.length,
    seededDue: seededPlan.due,
    locked: locked.status,
  };
}

async function main() {
  const result = await runLunaOpsSchedulerSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`luna-ops-scheduler-smoke ok jobs=${result.jobs.length}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-ops-scheduler-smoke 실패:' });
}
