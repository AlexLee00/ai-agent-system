#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildRuntimeExecutionRiskGuardDecision,
  summarizeRuntimeExecutionRiskGuardRows,
} from './runtime-execution-risk-guard-report.ts';

function row(blockCode, exchange = 'binance', blockedBy = 'smoke') {
  return {
    block_code: blockCode,
    exchange,
    block_meta: { execution_blocked_by: blockedBy },
  };
}

export function runRiskApprovalExecutionGuardReportSmoke() {
  const staleSummary = summarizeRuntimeExecutionRiskGuardRows([
    row('sec004_stale_approval'),
    row('sec015_nemesis_bypass_guard'),
  ]);
  const stale = buildRuntimeExecutionRiskGuardDecision(staleSummary);
  assert.equal(stale.status, 'execution_risk_guard_stale_attention');
  assert.equal(stale.metrics.staleCount, 1);
  assert.equal(stale.metrics.bypassCount, 1);

  const bypassSummary = summarizeRuntimeExecutionRiskGuardRows([
    row('sec004_nemesis_bypass_guard'),
    row('sec015_overseas_nemesis_bypass_guard', 'kis_overseas'),
  ]);
  const bypass = buildRuntimeExecutionRiskGuardDecision(bypassSummary);
  assert.equal(bypass.status, 'execution_risk_guard_bypass_attention');
  assert.equal(bypass.metrics.bypassCount, 2);
  assert.equal(bypass.metrics.byExchange[0].key, 'binance');

  const watchSummary = summarizeRuntimeExecutionRiskGuardRows([
    row('risk_approval_execution', 'kis'),
  ]);
  const watch = buildRuntimeExecutionRiskGuardDecision(watchSummary);
  assert.equal(watch.status, 'execution_risk_guard_watch');
  assert.equal(watch.metrics.total, 1);

  const ok = buildRuntimeExecutionRiskGuardDecision(summarizeRuntimeExecutionRiskGuardRows([]));
  assert.equal(ok.status, 'execution_risk_guard_ok');

  return {
    ok: true,
    stale,
    bypass,
    watch,
  };
}

async function main() {
  const result = runRiskApprovalExecutionGuardReportSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('risk approval execution guard report smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ risk approval execution guard report smoke 실패:',
  });
}
