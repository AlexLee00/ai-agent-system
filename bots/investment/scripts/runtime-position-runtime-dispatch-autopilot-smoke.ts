#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import {
  applyExecutionScopeGate,
  buildCandidateExecutionKey,
  buildExecutionInvocation,
  buildCandidates,
  buildBlockedCandidates,
  classifyChildExecutionOutput,
  computeDeferredGuardRetryMinutes,
  buildGuardReasonSummary,
  detectTerminalChildFailure,
  inspectBrokerCredentialGate,
  pruneStaleMarketQueueEntries,
  renderText,
} from './runtime-position-runtime-dispatch.ts';
import { runPositionRuntimeAutopilot } from './runtime-position-runtime-autopilot.ts';
import { buildAutopilotBottleneckReport } from './runtime-position-runtime-autopilot-bottleneck-report.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let passed = 0;
let failed = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed += 1;
    return;
  }
  console.error(`  ❌ ${label}`);
  failed += 1;
}

async function main() {
  console.log('🧪 runtime-position-runtime-dispatch/autopilot smoke test');
  await db.initSchema();

  const sampleRows = [
    {
      exchange: 'kis',
      symbol: '000660',
      tradeMode: 'normal',
      strategyName: 's1',
      setupType: 'breakout',
      runtimeState: {
        reasonCode: 'risk_exit',
        regime: { regime: 'trending_bear' },
        monitoringPolicy: { cadenceMs: 20000, sourceQualityBlocked: true },
        validationState: { severity: 'critical' },
        executionIntent: {
          action: 'EXIT',
          command: 'echo EXIT',
          urgency: 'high',
          executionAllowed: false,
          guardReasons: ['source_quality_blocked', 'validation_severity_critical'],
        },
      },
    },
    {
      exchange: 'binance',
      symbol: 'PHA/USDT',
      tradeMode: 'normal',
      strategyName: 's2',
      setupType: 'momentum_rotation',
      runtimeState: {
        reasonCode: 'profit_lock_candidate',
        regime: { regime: 'volatile' },
        monitoringPolicy: { cadenceMs: 10000, sourceQualityBlocked: false },
        validationState: { severity: 'warning' },
        executionIntent: {
          action: 'ADJUST',
          command: 'echo ADJUST',
          urgency: 'normal',
          executionAllowed: true,
          guardReasons: [],
        },
      },
    },
  ];

  const candidates = buildCandidates(sampleRows);
  const blocked = buildBlockedCandidates(sampleRows);
  const summary = buildGuardReasonSummary(blocked, 3);
  assert('executionAllowed=false 후보는 실행 candidate 제외', candidates.length === 1 && candidates[0].symbol === 'PHA/USDT');
  assert('blocked 후보 집계 포함', blocked.length === 1 && blocked[0].symbol === '000660');
  assert('guard reason summary 집계', summary.blockedActionable === 1 && summary.topReasons.length >= 1);
  const renderedBlocked = renderText({
    status: 'position_runtime_dispatch_blocked',
    candidates: [],
    blockedCandidates: blocked,
    guardReasonSummary: summary,
    marketQueue: { total: 0, waitingMarketOpen: 0, retrying: 0 },
  });
  assert(
    'render output에 topReasons 노출',
    renderedBlocked.includes('guard reason top:') && renderedBlocked.includes(String(summary.topReasons[0]?.reason || '')),
  );

  const scopeGate = applyExecutionScopeGate([
    {
      exchange: 'kis',
      symbol: '005090',
      tradeMode: 'normal',
      brokerScope: 'kis:live:005090',
      executionScope: 'kis:live:005090:normal:pos1:EXIT',
      action: 'EXIT',
      isHardExit: true,
    },
    {
      exchange: 'kis',
      symbol: '005090',
      tradeMode: 'validation',
      brokerScope: 'kis:live:005090',
      executionScope: 'kis:live:005090:validation:pos1:EXIT',
      action: 'EXIT',
      isHardExit: true,
    },
  ]);
  assert(
    'hard-exit 중복 scope는 normal 1건만 선택',
    scopeGate.selected.length === 1
      && scopeGate.selected[0].tradeMode === 'normal'
      && scopeGate.suppressed.length === 1,
  );

  const previewClassified = classifyChildExecutionOutput(JSON.stringify({ mode: 'preview', ok: true }), { phase6: true });
  assert(
    'dispatch child preview 결과는 실행 성공으로 집계하지 않음',
    previewClassified.ok === false && previewClassified.status === 'child_preview_not_execution',
  );

  const executedClassified = classifyChildExecutionOutput(
    JSON.stringify({ mode: 'execute', ok: true, executionStatus: 'executed', closeoutReviewId: 'r1' }),
    { phase6: true },
  );
  assert(
    'dispatch child execute 결과는 실행 성공으로 집계',
    executedClassified.ok === true && executedClassified.status === 'child_executed_verified',
  );
  const noisyLargePayload = `${'> @ai-agent/investment@2.1.0 runtime:partial-adjust\n'}${JSON.stringify({
    mode: 'execute',
    ok: true,
    executionStatus: 'executed',
    result: Array.from({ length: 80 }, (_, index) => ({
      index,
      nested: { a: { b: { c: index } } },
    })),
  }, null, 2)}`;
  const noisyLargeClassified = classifyChildExecutionOutput(noisyLargePayload, { phase6: true });
  assert(
    'npm banner + 큰 nested JSON payload도 tail JSON으로 파싱',
    noisyLargeClassified.ok === true && noisyLargeClassified.status === 'child_executed_verified',
  );
  const kisCredentialBlocked = inspectBrokerCredentialGate(
    { exchange: 'kis', symbol: '005090' },
    {
      getKisAppKey: () => 'valid-key',
      getKisAppSecret: () => '',
      getKisAccount: () => ({ cano: '12345678', acntPrdtCd: '01' }),
    },
  );
  assert(
    'KIS AppSecret 누락은 주문 실행 전 broker credential gate에서 차단',
    kisCredentialBlocked.ok === false
      && kisCredentialBlocked.missing.includes('kis_app_secret')
      && kisCredentialBlocked.reason.includes('kis_app_secret'),
  );
  const kisCredentialReady = inspectBrokerCredentialGate(
    { exchange: 'kis_overseas', symbol: 'AAPL' },
    {
      getKisAppKey: () => 'valid-key',
      getKisAppSecret: () => 'valid-secret',
      getKisAccount: () => ({ cano: '12345678', acntPrdtCd: '01' }),
    },
  );
  assert(
    'KIS broker credential gate는 key/secret/account가 있으면 통과',
    kisCredentialReady.ok === true && kisCredentialReady.reason === 'broker_credentials_ready',
  );

  assert(
    'stale candidate는 terminal failure 대신 no-op 분류 대상',
    detectTerminalChildFailure('partial-adjust 후보를 찾지 못했습니다: symbol=LDO/USDT') === 'candidate_not_found',
  );
  assert(
    'closeout cooldown은 retry failure가 아닌 idempotent skip 분류 대상',
    detectTerminalChildFailure('partial-adjust closeout guard: cooldown: 최근 30분 이내 동일 closeout 존재') === 'closeout_guard_cooldown',
  );
  assert(
    'strategy-exit 최소 보유시간 가드는 실패가 아닌 deferred guard 분류 대상',
    detectTerminalChildFailure('strategy-exit preflight blocked: - strategy exit guard: 전략 최소 보유시간 3.6h 미만 (0.0h)') === 'strategy_exit_min_hold_guard',
  );
  assert(
    'partial-adjust 잔고 잠금 preflight는 hard failure가 아닌 deferred guard 분류 대상',
    detectTerminalChildFailure(
      'partial-adjust preflight blocked: partial_adjust_balance_locked_by_open_sell_orders | 기존 SELL 보호/지정가 주문이 잔고를 잠그고 있어 partial-adjust 실행을 차단합니다. openSellOrders=2',
    ) === 'partial_adjust_balance_locked_by_open_sell_orders',
  );
  assert(
    'strategy-exit 최소 보유시간 가드는 남은 시간 기반 retry 지연 계산',
    computeDeferredGuardRetryMinutes(
      'strategy_exit_min_hold_guard',
      'strategy exit guard: 전략 최소 보유시간 3.6h 미만 (0.0h)',
      5,
    ) === 216,
  );
  assert(
    'queued retry와 fresh candidate는 동일 execution key로 중복 실행 방지 가능',
    buildCandidateExecutionKey({
      executionScope: 'binance:live:live:binance:PUMP/USDT:normal:binance:PUMP/USDT:normal:EXIT',
      action: 'EXIT',
    }) === buildCandidateExecutionKey({
      executionScope: 'binance:live:live:binance:PUMP/USDT:normal:binance:PUMP/USDT:normal:EXIT',
      action: 'EXIT',
    }, 'fallback'),
  );
  const stalePruned = pruneStaleMarketQueueEntries(
    [
      {
        queueKey: 'binance:live:MEGA',
        candidate: {
          executionScope: 'binance:live:live:binance:MEGA/USDT:normal:binance:MEGA/USDT:normal:ADJUST',
          action: 'ADJUST',
          exchange: 'binance',
          symbol: 'MEGA/USDT',
          tradeMode: 'normal',
        },
      },
    ],
    [
      {
        executionScope: 'binance:live:live:binance:KNC/USDT:normal:binance:KNC/USDT:normal:ADJUST',
        action: 'ADJUST',
        exchange: 'binance',
        symbol: 'KNC/USDT',
        tradeMode: 'normal',
      },
    ],
    [],
  );
  assert(
    '현재 candidate 집합에 없는 queue entry는 stale로 제거',
    stalePruned.keptEntries.length === 0 && stalePruned.staleEntries.length === 1,
  );

  const phase6RunnerInvocation = buildExecutionInvocation({
    runner: 'runtime:partial-adjust',
    runnerArgs: {
      symbol: 'BTC/USDT',
      exchange: 'binance',
      'trade-mode': 'normal',
      execute: true,
      confirm: 'position-runtime-autopilot',
      'run-context': 'position-runtime-autopilot',
      json: true,
    },
    manualExecuteCommand: 'npm --prefix /tmp run runtime:partial-adjust -- --execute --confirm=partial-adjust',
    autonomousExecuteCommand: 'npm --prefix /tmp run runtime:partial-adjust -- --execute --confirm=position-runtime-autopilot --run-context=position-runtime-autopilot',
  }, { phase6: true });
  assert(
    'phase6 실행은 runnerArgs 경로 우선',
    phase6RunnerInvocation?.kind === 'runner' && String(phase6RunnerInvocation?.command || '').includes('position-runtime-autopilot'),
  );

  const phase6AutonomousFallback = buildExecutionInvocation({
    manualExecuteCommand: 'npm --prefix /tmp run runtime:strategy-exit -- --execute --confirm=strategy-exit',
    autonomousExecuteCommand: 'npm --prefix /tmp run runtime:strategy-exit -- --execute --confirm=position-runtime-autopilot --run-context=position-runtime-autopilot',
  }, { phase6: true });
  assert(
    'phase6 실행은 manual이 아닌 autonomousExecuteCommand fallback',
    phase6AutonomousFallback?.kind === 'shell' && phase6AutonomousFallback?.command?.includes('position-runtime-autopilot'),
  );

  const nonPhase6ManualFallback = buildExecutionInvocation({
    manualExecuteCommand: 'npm --prefix /tmp run runtime:strategy-exit -- --execute --confirm=strategy-exit',
    autonomousExecuteCommand: 'npm --prefix /tmp run runtime:strategy-exit -- --execute --confirm=position-runtime-autopilot --run-context=position-runtime-autopilot',
  }, { phase6: false });
  assert(
    'non-phase6 실행은 manualExecuteCommand fallback',
    nonPhase6ManualFallback?.kind === 'shell' && nonPhase6ManualFallback?.command?.includes('--confirm=strategy-exit'),
  );

  const phase6NoAutonomousPath = buildExecutionInvocation({
    manualExecuteCommand: 'npm --prefix /tmp run runtime:strategy-exit -- --execute --confirm=strategy-exit',
  }, { phase6: true });
  assert(
    'phase6에서 manual fallback은 금지',
    phase6NoAutonomousPath == null,
  );

  const blockedAutopilot = await runPositionRuntimeAutopilot({
    execute: true,
    confirm: 'position-runtime-autopilot',
    applyTuning: false,
    executeDispatch: false,
    skipOrphanProfileSweep: true,
    phase6SafetyReadiness: {
      ok: false,
      checks: [{ key: 'mock_phase6_guard', ok: false }],
    },
  });
  assert(
    'phase6 safety readiness=false면 autopilot execute 차단',
    blockedAutopilot?.ok === false && blockedAutopilot?.status === 'position_runtime_autopilot_blocked_by_phase6_safety',
  );

  const sweepCalls = [];
  const sweptAutopilot = await runPositionRuntimeAutopilot({
    execute: true,
    confirm: 'position-runtime-autopilot',
    applyTuning: false,
    executeDispatch: false,
    applyOrphanProfileSweep: true,
    recordHistory: false,
    phase6SafetyReadiness: { ok: true, checks: [] },
    orphanProfileSweeper: async (options) => {
      sweepCalls.push(options);
      return {
        ok: true,
        apply: options.apply,
        exchange: options.exchange,
        candidates: 2,
        retired: options.apply ? 2 : 0,
        summary: {
          orphanProfiles: 2,
          retirements: options.apply ? 2 : 0,
        },
        decision: {
          status: options.apply ? 'orphan_strategy_profiles_retired' : 'orphan_strategy_profiles_candidates',
        },
        rows: [],
      };
    },
  });
  assert(
    'autopilot execute는 confirm+safety 통과 시 orphan strategy profile sweep을 apply로 선행',
    sweepCalls.length === 1
      && sweepCalls[0].apply === true
      && sweepCalls[0].exchange === 'binance'
      && sweptAutopilot?.orphanProfileSweep?.status === 'orphan_strategy_profiles_retired'
      && sweptAutopilot?.orphanProfileSweep?.retired === 2,
  );

  const historyFile = path.join(os.tmpdir(), `autopilot-bottleneck-${Date.now()}.jsonl`);
  fs.writeFileSync(historyFile, [
    JSON.stringify({
      recordedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      status: 'position_runtime_autopilot_executed_with_dispatch_failures',
      dispatchFailureCount: 1,
      dispatchFailures: [{ exchange: 'binance', symbol: 'OLD/USDT', status: 'child_process_error' }],
    }),
    JSON.stringify({
      recordedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
      status: 'position_runtime_autopilot_executed',
      dispatchFailureCount: 0,
      dispatchSkipped: [{ exchange: 'binance', symbol: 'STALE/USDT', status: 'candidate_not_found' }],
    }),
    JSON.stringify({
      recordedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      status: 'position_runtime_autopilot_executed',
      dispatchFailureCount: 0,
      dispatchSkipped: [{ exchange: 'binance', symbol: 'STALE/USDT', status: 'candidate_not_found' }],
    }),
    JSON.stringify({
      recordedAt: new Date().toISOString(),
      status: 'position_runtime_autopilot_executed',
      dispatchFailureCount: 0,
    }),
  ].join('\n') + '\n');
  const bottleneck = buildAutopilotBottleneckReport({ file: historyFile, hours: 24, minCleanSamples: 3 });
  assert(
    'MAPE-K 병목은 최근 clean streak이면 과거 hard failure를 차단 조건에서 제외',
    bottleneck.ok === true
      && bottleneck.dispatch.hardFailureCount === 0
      && bottleneck.dispatch.historicalHardFailureCount === 1
      && bottleneck.dispatch.cleanStreakSamples >= 3,
  );
  assert(
    'stale candidate는 전체 누적과 최근 윈도우를 분리해 경고 노이즈를 줄임',
    bottleneck.dispatch.staleCandidateCount === 2
      && bottleneck.dispatch.recentStaleCandidateCount === 2
      && bottleneck.dispatch.recentStaleSampleCount === 3,
  );
  const staleRecovered = buildAutopilotBottleneckReport({
    file: historyFile,
    hours: 24,
    minCleanSamples: 3,
    recentStaleSamples: 1,
  });
  assert(
    '최근 윈도우에 재발하지 않은 stale candidate는 historical noise로 분리',
    staleRecovered.dispatch.staleCandidateCount === 2
      && staleRecovered.dispatch.recentStaleCandidateCount === 0,
  );
  fs.rmSync(historyFile, { force: true });

  console.log('');
  console.log(`결과: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

await main();
