#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildOpsSchedulerPlan,
  classifyOpsSchedulerOutcome,
  getOpsSchedulerJobs,
  resolveOnlyJobArg,
  runOpsScheduler,
  seedOpsSchedulerState,
} from './runtime-luna-ops-scheduler.ts';

export async function runLunaOpsSchedulerSmoke() {
  const jobs = getOpsSchedulerJobs();
  assert.equal(jobs.length, 15);
  assert.equal(jobs.some((job) => job.name === 'discovery_candidate_refresh'), true);
  assert.equal(jobs.some((job) => job.name === 'market_cycle_crypto'), true);
  assert.equal(jobs.some((job) => job.name === 'market_cycle_domestic'), true);
  assert.equal(jobs.some((job) => job.name === 'market_cycle_domestic_open_catchup'), true);
  assert.equal(jobs.some((job) => job.name === 'market_cycle_overseas'), true);
  assert.equal(jobs.some((job) => job.name === 'discovery_funnel_report'), true);
  assert.equal(jobs.some((job) => job.name === 'active_candidate_analysis_refresh_crypto'), true);
  assert.equal(jobs.some((job) => job.name === 'near_miss_watchlist_crypto'), true);
  assert.equal(jobs.find((job) => job.name === 'market_cycle_domestic')?.env?.LUNA_LIVE_DOMESTIC, 'true');
  assert.equal(jobs.find((job) => job.name === 'market_cycle_domestic_open_catchup')?.env?.LUNA_LIVE_DOMESTIC, 'true');
  assert.equal(jobs.find((job) => job.name === 'market_cycle_overseas')?.env?.LUNA_LIVE_OVERSEAS, 'true');

  const now = new Date('2026-05-04T02:00:00+09:00');
  const emptyPlan = buildOpsSchedulerPlan({ now, state: { jobs: {} }, jobs });
  assert.equal(emptyPlan.due, 15);

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
  const envByJob = {};
  const executed = await runOpsScheduler({
    now,
    statePath,
    lockPath,
    jobs,
    runner: (job) => {
      calls.push(job.name);
      envByJob[job.name] = job.env || {};
      if (job.name === 'market_cycle_domestic') {
        return { ok: true, status: 0, stdoutTail: '⏭️ 장외 시간 (KST 08:50) — 연구 모드 전환', stderrTail: '' };
      }
      return { ok: true, status: 0, stdoutTail: 'ok', stderrTail: '' };
    },
  });
  assert.equal(executed.ok, true);
  assert.equal(calls.length, 15);
  assert.equal(envByJob.market_cycle_domestic?.LUNA_LIVE_DOMESTIC, 'true');
  assert.equal(envByJob.market_cycle_domestic_open_catchup?.LUNA_LIVE_DOMESTIC, 'true');
  assert.equal(envByJob.market_cycle_overseas?.LUNA_LIVE_OVERSEAS, 'true');
  const executedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(Object.keys(executedState.jobs).length, 15);
  assert.equal(executedState.jobs.market_cycle_domestic.lastOutcome, 'market_closed_research');
  assert.equal(executedState.jobs.market_cycle_domestic.lastSummary.includes('장외 시간'), true);
  assert.equal(executedState.jobs.market_cycle_domestic_open_catchup.lastOutcome, 'ok');

  assert.deepEqual(
    classifyOpsSchedulerOutcome(
      { name: 'market_cycle_domestic' },
      { ok: true, stdoutTail: '최종 결과: 0개 신호 승인', stderrTail: '' },
    ),
    { outcome: 'no_signals', summary: 'approved_signals=0', approvedSignals: 0 },
  );
  assert.equal(
    classifyOpsSchedulerOutcome(
      { name: 'market_cycle_domestic_open_catchup' },
      { ok: true, stdoutTail: '⏭️ 국내장 open-catchup: 장외 시간 (KST 08:55) — live cycle 대기', stderrTail: '' },
    ).outcome,
    'market_closed_catchup_wait',
  );

  assert.equal(
    classifyOpsSchedulerOutcome(
      { name: 'discovery_candidate_refresh' },
      { ok: true, stdoutTail: '[discovery-orchestrator] 완료 — 성공 2/3, 총 2개 신호', stderrTail: '' },
    ).outcome,
    'discovery_refreshed',
  );

  const seedPath = path.join(tmp, 'seeded-state.json');
  const seeded = seedOpsSchedulerState({ now, statePath: seedPath, jobs });
  assert.equal(seeded.ok, true);
  const seededPlan = buildOpsSchedulerPlan({
    now,
    jobs,
    state: JSON.parse(fs.readFileSync(seedPath, 'utf8')),
  });
  assert.equal(seededPlan.due, 0);

  fs.writeFileSync(lockPath, JSON.stringify({ lockedAt: now.toISOString(), pid: process.pid }));
  const locked = await runOpsScheduler({ now, statePath, lockPath, jobs });
  assert.equal(locked.ok, false);
  assert.equal(locked.status, 'locked');
  fs.rmSync(lockPath, { force: true });

  fs.writeFileSync(lockPath, JSON.stringify({ lockedAt: now.toISOString(), pid: 999999 }));
  const staleRecovered = await runOpsScheduler({ now, statePath, lockPath, jobs: [], runner: () => ({ ok: true }) });
  assert.equal(staleRecovered.ok, true);
  assert.equal(staleRecovered.status, 'executed');
  fs.rmSync(lockPath, { force: true });

  const envEchoScript = path.join(tmp, 'echo-env.js');
  fs.writeFileSync(
    envEchoScript,
    `console.log(JSON.stringify({ overseas: process.env.LUNA_LIVE_OVERSEAS || null }));\n`,
    'utf8',
  );
  const envStatePath = path.join(tmp, 'env-state.json');
  const envLockPath = path.join(tmp, 'env-lock.json');
  const envExecution = await runOpsScheduler({
    now,
    statePath: envStatePath,
    lockPath: envLockPath,
    jobs: [{
      name: 'market_cycle_overseas',
      cadence: { type: 'interval', seconds: 1 },
      command: process.execPath,
      args: [envEchoScript],
      env: { LUNA_LIVE_OVERSEAS: 'true' },
    }],
  });
  assert.equal(envExecution.ok, true);
  assert.match(envExecution.executed[0]?.stdoutTail || '', /"overseas":"true"/);

  assert.equal(
    classifyOpsSchedulerOutcome(
      { name: 'market_cycle_overseas' },
      { ok: true, stdoutTail: '[overseas] LIVE OFF — 사이클 스킵 (LUNA_LIVE_OVERSEAS 미설정)', stderrTail: '' },
    ).outcome,
    'kill_switch_off',
  );

  return {
    ok: true,
    jobs: jobs.map((job) => job.name),
    emptyDue: emptyPlan.due,
    forcedDue: forced.due,
    executed: calls.length,
    seededDue: seededPlan.due,
    locked: locked.status,
    staleRecovered: staleRecovered.ok,
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
