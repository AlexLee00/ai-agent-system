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
  resolveAgentPlanArg,
  resolveOnlyJobArg,
  runOpsScheduler,
  seedOpsSchedulerState,
} from './runtime-luna-ops-scheduler.ts';
import { shouldSkipPreScreen } from './pre-market-screen.ts';

export async function runLunaOpsSchedulerSmoke() {
  const jobs = getOpsSchedulerJobs();
  const launchdPlist = fs.readFileSync(new URL('../launchd/ai.luna.ops-scheduler.plist', import.meta.url), 'utf8');
  assert.match(launchdPlist, /<key>StartInterval<\/key>\s*<integer>60<\/integer>/);
  assert.equal(jobs.length, 34);
  assert.equal(jobs.some((job) => job.name === 'market_regime_llm_shadow'), true);
  assert.equal(jobs.find((job) => job.name === 'market_regime_llm_shadow')?.category, 'market_state');
  assert.equal(jobs.find((job) => job.name === 'market_regime_llm_shadow')?.cadence?.seconds, 3600);
  assert.equal(jobs.find((job) => job.name === 'market_regime_llm_shadow')?.args?.includes('--confirm=luna-regime-llm-shadow'), true);
  assert.equal(jobs.some((job) => job.name === 'dynamic_policy_operator'), true);
  assert.equal(jobs.find((job) => job.name === 'dynamic_policy_operator')?.args?.includes('--confirm=luna-dynamic-policy-autotune'), true);
  assert.equal(jobs.some((job) => job.name === 'discovery_candidate_refresh'), true);
  assert.equal(jobs.find((job) => job.name === 'discovery_candidate_refresh')?.market, 'crypto');
  assert.equal(jobs.find((job) => job.name === 'discovery_candidate_refresh')?.args?.includes('--markets=crypto'), true);
  assert.equal(jobs.find((job) => job.name === 'discovery_candidate_refresh')?.args?.includes('--limit=30'), true);
  assert.equal(jobs.find((job) => job.name === 'discovery_candidate_refresh')?.args?.includes('--ttl-hours=6'), true);
  assert.equal(jobs.some((job) => job.name === 'pre_market_screen_domestic'), true);
  assert.equal(jobs.some((job) => job.name === 'pre_market_screen_overseas'), true);
  assert.equal(jobs.some((job) => job.name === 'pre_market_analysis_refresh_domestic'), true);
  assert.equal(jobs.some((job) => job.name === 'pre_market_analysis_refresh_overseas'), true);
  assert.equal(jobs.find((job) => job.name === 'pre_market_screen_domestic')?.cadence?.type, 'daily');
  assert.equal(jobs.find((job) => job.name === 'pre_market_screen_overseas')?.cadence?.type, 'daily');
  assert.equal(jobs.find((job) => job.name === 'pre_market_analysis_refresh_domestic')?.requiresMarketOpen, undefined);
  assert.equal(jobs.find((job) => job.name === 'pre_market_analysis_refresh_domestic')?.args?.includes('--max-symbols=5'), true);
  assert.equal(jobs.find((job) => job.name === 'pre_market_analysis_refresh_domestic')?.args?.includes('--max-enrichment-symbols=2'), true);
  assert.equal(jobs.find((job) => job.name === 'pre_market_analysis_refresh_overseas')?.requiresMarketOpen, undefined);
  assert.equal(jobs.find((job) => job.name === 'pre_market_analysis_refresh_overseas')?.args?.includes('--max-symbols=5'), true);
  assert.equal(jobs.find((job) => job.name === 'pre_market_analysis_refresh_overseas')?.args?.includes('--max-enrichment-symbols=2'), true);
  assert.equal(shouldSkipPreScreen({ isOpen: true }), true);
  assert.equal(shouldSkipPreScreen({ isOpen: false, isWeekend: false, holiday: { isHoliday: false } }), false);
  assert.equal(jobs.some((job) => job.name === 'market_cycle_crypto'), true);
  assert.equal(jobs.some((job) => job.name === 'active_entry_trigger_evaluator_crypto'), true);
  assert.equal(jobs.find((job) => job.name === 'active_entry_trigger_evaluator_crypto')?.cadence?.seconds, 60);
  assert.equal(jobs.find((job) => job.name === 'active_entry_trigger_evaluator_crypto')?.args?.includes('--derive-market-events'), true);
  assert.equal(jobs.some((job) => job.name === 'entry_llm_shadow'), true);
  assert.equal(jobs.find((job) => job.name === 'entry_llm_shadow')?.category, 'decision_shadow');
  assert.equal(jobs.find((job) => job.name === 'entry_llm_shadow')?.cadence?.seconds, 600);
  assert.equal(jobs.find((job) => job.name === 'entry_llm_shadow')?.args?.includes('--confirm=luna-entry-llm-shadow'), true);
  assert.equal(jobs.find((job) => job.name === 'entry_llm_shadow')?.args?.includes('--max-llm-calls=3'), true);
  assert.equal(jobs.find((job) => job.name === 'entry_llm_shadow')?.args?.includes('--exchanges=binance,kis,kis_overseas'), true);
  assert.equal(jobs.some((job) => job.name === 'tradingview_open_position_subscription_sync'), true);
  assert.equal(jobs.find((job) => job.name === 'tradingview_open_position_subscription_sync')?.category, 'position_monitor');
  assert.equal(jobs.find((job) => job.name === 'tradingview_open_position_subscription_sync')?.cadence?.seconds, 300);
  assert.equal(jobs.find((job) => job.name === 'tradingview_open_position_subscription_sync')?.args?.includes('--confirm=luna-tradingview-position-subscription-sync'), true);
  assert.equal(jobs.find((job) => job.name === 'tradingview_open_position_subscription_sync')?.args?.includes('--timeframes=60,240,D'), true);
  assert.equal(jobs.some((job) => job.name === 'approved_signal_executor_crypto'), true);
  assert.equal(jobs.find((job) => job.name === 'approved_signal_executor_crypto')?.category, 'execution');
  assert.equal(jobs.find((job) => job.name === 'approved_signal_executor_crypto')?.cadence?.seconds, 60);
  assert.equal(jobs.find((job) => job.name === 'approved_signal_executor_crypto')?.env?.PAPER_MODE, 'false');
  assert.equal(jobs.find((job) => job.name === 'approved_signal_executor_crypto')?.env?.INVESTMENT_TRADE_MODE, 'normal');
  assert.equal(jobs.some((job) => job.name === 'market_cycle_domestic'), true);
  assert.equal(jobs.some((job) => job.name === 'market_cycle_domestic_open_catchup'), true);
  assert.equal(jobs.some((job) => job.name === 'market_cycle_overseas'), true);
  assert.equal(jobs.find((job) => job.name === 'market_cycle_domestic')?.requiresMarketOpen, true);
  assert.equal(jobs.find((job) => job.name === 'market_cycle_domestic_open_catchup')?.requiresMarketOpen, true);
  assert.equal(jobs.find((job) => job.name === 'market_cycle_overseas')?.requiresMarketOpen, true);
  assert.equal(jobs.some((job) => job.name === 'discovery_funnel_report'), true);
  assert.equal(jobs.some((job) => job.name === 'active_candidate_analysis_refresh_crypto'), true);
  assert.equal(jobs.some((job) => job.name === 'active_candidate_analysis_refresh_domestic'), true);
  assert.equal(jobs.some((job) => job.name === 'active_candidate_analysis_refresh_overseas'), true);
  assert.equal(jobs.find((job) => job.name === 'active_candidate_analysis_refresh_crypto')?.cadence?.seconds, 1800);
  assert.equal(jobs.find((job) => job.name === 'active_candidate_analysis_refresh_crypto')?.args?.includes('--max-symbols=2'), true);
  assert.equal(jobs.find((job) => job.name === 'active_candidate_analysis_refresh_domestic')?.requiresMarketOpen, true);
  assert.equal(jobs.find((job) => job.name === 'active_candidate_analysis_refresh_domestic')?.allowPreMarketRefresh, true);
  assert.equal(jobs.find((job) => job.name === 'active_candidate_analysis_refresh_domestic')?.preMarketWindowMinutes, 240);
  assert.equal(jobs.find((job) => job.name === 'active_candidate_analysis_refresh_overseas')?.requiresMarketOpen, true);
  assert.equal(jobs.find((job) => job.name === 'active_candidate_analysis_refresh_overseas')?.allowPreMarketRefresh, true);
  assert.equal(jobs.find((job) => job.name === 'active_candidate_analysis_refresh_overseas')?.preMarketWindowMinutes, 1080);
  assert.equal(jobs.some((job) => job.name === 'near_miss_watchlist_crypto'), true);
  assert.equal(jobs.some((job) => job.name === 'near_miss_watchlist_domestic'), true);
  assert.equal(jobs.some((job) => job.name === 'near_miss_watchlist_overseas'), true);
  assert.equal(jobs.find((job) => job.name === 'near_miss_watchlist_crypto')?.cadence?.seconds, 1800);
  assert.equal(jobs.some((job) => job.name === 'relaxed_probe_l13_crypto'), true);
  assert.equal(jobs.find((job) => job.name === 'relaxed_probe_l13_crypto')?.cadence?.seconds, 900);
  assert.equal(jobs.find((job) => job.name === 'relaxed_probe_l13_crypto')?.args?.includes('--confirm=luna-relaxed-probe-runner'), true);
  assert.equal(jobs.find((job) => job.name === 'relaxed_probe_l13_crypto')?.args?.includes('--max-symbols=1'), true);
  assert.equal(jobs.some((job) => job.name === 'relaxed_probe_l13_domestic'), true);
  assert.equal(jobs.find((job) => job.name === 'relaxed_probe_l13_domestic')?.requiresMarketOpen, true);
  assert.equal(jobs.find((job) => job.name === 'relaxed_probe_l13_domestic')?.cadence?.seconds, 900);
  assert.equal(jobs.find((job) => job.name === 'relaxed_probe_l13_domestic')?.args?.includes('--market=domestic'), true);
  assert.equal(jobs.some((job) => job.name === 'relaxed_probe_l13_overseas'), true);
  assert.equal(jobs.find((job) => job.name === 'relaxed_probe_l13_overseas')?.requiresMarketOpen, true);
  assert.equal(jobs.find((job) => job.name === 'relaxed_probe_l13_overseas')?.cadence?.seconds, 900);
  assert.equal(jobs.find((job) => job.name === 'relaxed_probe_l13_overseas')?.args?.includes('--market=overseas'), true);
  assert.equal(jobs.find((job) => job.name === 'near_miss_watchlist_domestic')?.requiresMarketOpen, true);
  assert.equal(jobs.find((job) => job.name === 'near_miss_watchlist_overseas')?.requiresMarketOpen, true);
  assert.equal(jobs.find((job) => job.name === 'market_cycle_domestic')?.env?.LUNA_LIVE_DOMESTIC, 'true');
  assert.equal(jobs.find((job) => job.name === 'market_cycle_domestic_open_catchup')?.env?.LUNA_LIVE_DOMESTIC, 'true');
  assert.equal(jobs.find((job) => job.name === 'market_cycle_overseas')?.env?.LUNA_LIVE_OVERSEAS, 'true');
  assert.equal(jobs.some((job) => job.name === 'external_evidence_gap_queue_worker'), true);
  assert.equal(jobs.find((job) => job.name === 'external_evidence_gap_queue_worker')?.args?.includes('--confirm=evidence-gap-queue'), true);
  assert.equal(jobs.find((job) => job.name === 'external_evidence_gap_queue_worker')?.cadence?.seconds, 300);
  assert.equal(jobs.some((job) => job.name === 'external_evidence_gap_backtest_worker'), true);
  assert.equal(jobs.find((job) => job.name === 'external_evidence_gap_backtest_worker')?.args?.includes('--include-backtest'), true);
  assert.equal(jobs.find((job) => job.name === 'external_evidence_gap_backtest_worker')?.cadence?.seconds, 3600);

  const now = new Date('2026-05-04T02:00:00+09:00');
  const emptyPlan = buildOpsSchedulerPlan({ now, state: { jobs: {} }, jobs });
  assert.equal(emptyPlan.due, 21);
  assert.equal(emptyPlan.jobs.find((job) => job.name === 'market_cycle_domestic')?.due, false);
  assert.equal(emptyPlan.jobs.find((job) => job.name === 'market_cycle_domestic')?.marketSession?.isOpen, false);
  assert.equal(emptyPlan.jobs.find((job) => job.name === 'market_cycle_domestic_open_catchup')?.due, false);
  assert.equal(emptyPlan.jobs.find((job) => job.name === 'market_cycle_overseas')?.due, false);
  assert.equal(emptyPlan.jobs.find((job) => job.name === 'active_candidate_analysis_refresh_domestic')?.due, false);
  assert.equal(emptyPlan.jobs.find((job) => job.name === 'active_candidate_analysis_refresh_domestic')?.marketSession?.isOpen, false);

  const domesticPreOpenPlan = buildOpsSchedulerPlan({
    now: new Date('2026-05-04T06:30:00+09:00'),
    state: { jobs: {} },
    jobs,
    onlyJob: 'active_candidate_analysis_refresh_domestic',
  });
  assert.equal(domesticPreOpenPlan.due, 1);
  assert.equal(domesticPreOpenPlan.jobs[0]?.marketSession?.isOpen, false);
  assert.equal(domesticPreOpenPlan.jobs[0]?.preMarketWindow?.active, true);
  assert.equal(domesticPreOpenPlan.jobs[0]?.preMarketWindow?.reasonCode, 'pre_market_refresh_window');

  const overseasPreOpenPlan = buildOpsSchedulerPlan({
    now: new Date('2026-05-04T12:00:00+09:00'),
    state: { jobs: {} },
    jobs,
    onlyJob: 'active_candidate_analysis_refresh_overseas',
  });
  assert.equal(overseasPreOpenPlan.due, 1);
  assert.equal(overseasPreOpenPlan.jobs[0]?.marketSession?.isOpen, false);
  assert.equal(overseasPreOpenPlan.jobs[0]?.preMarketWindow?.active, true);

  const overseasCyclePreOpenPlan = buildOpsSchedulerPlan({
    now: new Date('2026-05-04T12:00:00+09:00'),
    state: { jobs: {} },
    jobs,
    onlyJob: 'market_cycle_overseas',
  });
  assert.equal(overseasCyclePreOpenPlan.due, 0);

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
  assert.deepEqual(resolveAgentPlanArg(['--agent-plan-json={"disabledCategories":["report"]}']), { disabledCategories: ['report'] });

  const agentControlledPlan = buildOpsSchedulerPlan({
    now,
    state: { jobs: {} },
    jobs,
    agentPlan: {
      disabledCategories: ['report', 'learning'],
      disabledMarkets: ['domestic'],
      disabledJobs: ['market_cycle_crypto'],
      cadenceOverrides: {
        market_cycle_crypto: 10,
        active_candidate_analysis_refresh_crypto: 120,
      },
    },
  });
  const agentJobNames = agentControlledPlan.jobs.map((job) => job.name);
  assert.equal(agentJobNames.includes('market_cycle_crypto'), true);
  assert.equal(agentJobNames.includes('market_cycle_domestic'), true);
  assert.equal(agentJobNames.includes('active_candidate_analysis_refresh_domestic'), false);
  assert.equal(agentJobNames.includes('near_miss_watchlist_domestic'), false);
  assert.equal(agentJobNames.includes('active_candidate_analysis_refresh_overseas'), true);
  assert.equal(agentJobNames.includes('near_miss_watchlist_overseas'), true);
  assert.equal(agentJobNames.includes('discovery_funnel_report'), false);
  assert.equal(agentJobNames.includes('voyager_skill_acceleration'), false);
  assert.equal(agentControlledPlan.agentPlan.warnings.includes('immutable_scheduler_job:market_cycle_crypto'), true);
  assert.equal(agentControlledPlan.agentPlan.warnings.includes('immutable_scheduler_job:market_cycle_domestic'), true);
  assert.equal(agentControlledPlan.agentPlan.warnings.includes('cadence_override_clamped:market_cycle_crypto'), true);
  assert.equal(agentControlledPlan.jobs.find((job) => job.name === 'market_cycle_crypto')?.cadence?.seconds, 60);
  assert.equal(agentControlledPlan.jobs.find((job) => job.name === 'active_candidate_analysis_refresh_crypto')?.cadence?.seconds, 120);

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
  assert.equal(calls.length, 21);
  assert.equal(calls.includes('market_cycle_domestic'), false);
  assert.equal(calls.includes('market_cycle_domestic_open_catchup'), false);
  assert.equal(calls.includes('market_cycle_overseas'), false);
  const executedState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(Object.keys(executedState.jobs).length, 21);

  assert.deepEqual(
    classifyOpsSchedulerOutcome(
      { name: 'market_cycle_domestic' },
      { ok: true, stdoutTail: '최종 결과: 0개 신호 승인', stderrTail: '' },
    ),
    { outcome: 'no_signals', summary: 'approved_signals=0', approvedSignals: 0 },
  );
  assert.deepEqual(
    classifyOpsSchedulerOutcome(
      { name: 'active_entry_trigger_evaluator_crypto' },
      {
        ok: true,
        stdoutTail: JSON.stringify({
          ok: true,
          result: { checked: 2, fired: 0, readyBlocked: 0, allowLiveFire: true },
        }),
      },
    ),
    {
      outcome: 'entry_trigger_checked',
      summary: 'checked=2 fired=0 readyBlocked=0 allowLiveFire=true',
      approvedSignals: null,
    },
  );
  assert.deepEqual(
    classifyOpsSchedulerOutcome(
      { name: 'approved_signal_executor_crypto' },
      {
        ok: true,
        stdoutTail: '[헤파이스토스] 실행대상 복구 1건 (pending=0, approved=1, trade_mode=normal)',
      },
    ),
    {
      outcome: 'approved_signal_execution_attempted',
      summary: 'approved_signal_candidates=1',
      approvedSignals: 1,
    },
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

  const failedStatePath = path.join(tmp, 'failed-state.json');
  const failedLockPath = path.join(tmp, 'failed-lock.json');
  const failedExecution = await runOpsScheduler({
    now,
    statePath: failedStatePath,
    lockPath: failedLockPath,
    jobs: [{
      name: 'bounded_failure_job',
      cadence: { type: 'interval', seconds: 300 },
      command: process.execPath,
      args: ['-e', 'process.exit(1)'],
    }],
    runner: () => ({ ok: false, status: 1, error: 'fixture_failure' }),
  });
  assert.equal(failedExecution.ok, false);
  const failedState = JSON.parse(fs.readFileSync(failedStatePath, 'utf8'));
  assert.equal(failedState.jobs.bounded_failure_job.lastStatus, 'failed');
  assert.equal(failedState.jobs.bounded_failure_job.lastOutcome, 'command_failed');
  assert.equal(
    buildOpsSchedulerPlan({
      now: new Date(now.getTime() + 60_000),
      state: failedState,
      jobs: [{
        name: 'bounded_failure_job',
        cadence: { type: 'interval', seconds: 300 },
        command: process.execPath,
        args: ['-e', 'process.exit(1)'],
      }],
    }).due,
    0,
  );

  assert.equal(
    classifyOpsSchedulerOutcome(
      { name: 'market_cycle_overseas' },
      { ok: true, stdoutTail: '[overseas] LIVE OFF — 사이클 스킵 (LUNA_LIVE_OVERSEAS 미설정)', stderrTail: '' },
    ).outcome,
    'kill_switch_off',
  );
  assert.equal(
    classifyOpsSchedulerOutcome(
      { name: 'slow_job' },
      { ok: false, error: 'spawnSync ETIMEDOUT', signal: 'SIGTERM', stderrTail: '' },
    ).outcome,
    'command_timeout',
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
