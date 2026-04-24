#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import {
  applyExecutionScopeGate,
  buildCandidates,
  buildBlockedCandidates,
  classifyChildExecutionOutput,
  buildGuardReasonSummary,
} from './runtime-position-runtime-dispatch.ts';
import { runPositionRuntimeAutopilot } from './runtime-position-runtime-autopilot.ts';

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

  const scopeGate = applyExecutionScopeGate([
    {
      exchange: 'kis',
      symbol: '005090',
      tradeMode: 'normal',
      action: 'EXIT',
      isHardExit: true,
    },
    {
      exchange: 'kis',
      symbol: '005090',
      tradeMode: 'validation',
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

  const blockedAutopilot = await runPositionRuntimeAutopilot({
    execute: true,
    confirm: 'position-runtime-autopilot',
    applyTuning: false,
    executeDispatch: false,
    phase6SafetyReadiness: {
      ok: false,
      checks: [{ key: 'mock_phase6_guard', ok: false }],
    },
  });
  assert(
    'phase6 safety readiness=false면 autopilot execute 차단',
    blockedAutopilot?.ok === false && blockedAutopilot?.status === 'position_runtime_autopilot_blocked_by_phase6_safety',
  );

  console.log('');
  console.log(`결과: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
}

await main();
