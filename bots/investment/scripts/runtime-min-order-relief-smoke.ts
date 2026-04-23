#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildDecision as buildAutotuneDecision } from './runtime-autotune-readiness-report.ts';
import { buildDecision as buildReliefDecision } from './runtime-min-order-relief-report.ts';

const runtimeConfig = {
  luna: {
    stockOrderDefaults: {
      kis: {
        buyDefault: 500000,
        min: 200000,
        max: 1200000,
      },
    },
  },
  nemesis: {
    thresholds: {
      stockStarterApproveDomestic: 700000,
    },
  },
};

export function runRuntimeMinOrderReliefSmoke() {
  const pressure = {
    decision: {
      status: 'min_order_pressure',
      reasons: [
        '최근 5건 min_order_notional 블록',
        '평균 gap 80,479 KRW',
        '최대 gap 005090 81,199 KRW',
      ],
      metrics: {
        maxGap: 81199,
        maxGapAttempted: 118801,
        maxGapRequired: 200000,
      },
    },
  };
  const relief = buildReliefDecision({ pressure, runtimeConfig });
  assert.equal(relief.status, 'relief_sizing_floor_needed');
  assert.equal(relief.metrics.required, 200000);
  assert.equal(relief.metrics.sizingFloorNeeded, true);
  assert.equal(relief.metrics.blockedByOrderCap, false);

  const autotune = buildAutotuneDecision({
    allowValidation: { decision: { status: 'validation_idle', metrics: { ready: 0 } } },
    plannerCoverage: { decision: { status: 'planner_coverage_ready' } },
    minOrderPressure: pressure,
    minOrderRelief: { decision: relief },
    backtest: { decision: { status: 'backtest_ok' } },
  });
  assert.equal(autotune.status, 'autotune_waiting_sizing_floor');
  assert.equal(autotune.metrics.minOrderNeedsSizingFloor, true);

  return {
    ok: true,
    reliefStatus: relief.status,
    autotuneStatus: autotune.status,
  };
}

async function main() {
  const result = runRuntimeMinOrderReliefSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('runtime min-order relief smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime min-order relief smoke 실패:',
  });
}
