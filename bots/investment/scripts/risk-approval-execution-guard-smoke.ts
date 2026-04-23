#!/usr/bin/env node
// @ts-nocheck

import { buildExecutionRiskApprovalGuard } from '../shared/risk-approval-execution-guard.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function runRiskApprovalExecutionGuardSmoke() {
  const staleAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  const freshAt = new Date().toISOString();

  const bypass = buildExecutionRiskApprovalGuard({
    symbol: 'BTC/USDT',
    action: 'BUY',
    exchange: 'binance',
    amount_usdt: 100,
  }, {
    codePrefix: 'test',
    executionBlockedBy: 'smoke_guard',
  });

  const stale = buildExecutionRiskApprovalGuard({
    symbol: 'BTC/USDT',
    action: 'BUY',
    exchange: 'binance',
    amount_usdt: 100,
    nemesis_verdict: 'approved',
    approved_at: staleAt,
  }, {
    codePrefix: 'test',
    executionBlockedBy: 'smoke_guard',
  });

  const fresh = buildExecutionRiskApprovalGuard({
    symbol: 'BTC/USDT',
    action: 'BUY',
    exchange: 'binance',
    amount_usdt: 100,
    nemesis_verdict: 'modified',
    approved_at: freshAt,
  }, {
    codePrefix: 'test',
    executionBlockedBy: 'smoke_guard',
  });

  const sell = buildExecutionRiskApprovalGuard({
    symbol: 'BTC/USDT',
    action: 'SELL',
    exchange: 'binance',
    amount_usdt: 100,
  }, {
    codePrefix: 'test',
    executionBlockedBy: 'smoke_guard',
  });

  const paper = buildExecutionRiskApprovalGuard({
    symbol: 'BTC/USDT',
    action: 'BUY',
    exchange: 'binance',
    amount_usdt: 100,
  }, {
    codePrefix: 'test',
    executionBlockedBy: 'smoke_guard',
    paperMode: true,
  });

  assert(bypass.approved === false, 'expected missing nemesis approval to block');
  assert(bypass.code === 'test_nemesis_bypass_guard', `unexpected bypass code: ${bypass.code}`);
  assert(bypass.meta?.execution_blocked_by === 'smoke_guard', 'expected blocked_by metadata');

  assert(stale.approved === false, 'expected stale approval to block');
  assert(stale.code === 'test_stale_approval', `unexpected stale code: ${stale.code}`);
  assert(stale.meta?.risk_approval_execution?.decision === 'REJECT', 'expected freshness model rejection metadata');
  assert(stale.meta?.risk_approval_execution?.steps?.[0]?.model === 'execution_freshness', 'expected execution_freshness step');

  assert(fresh.approved === true, 'expected fresh modified verdict to pass');
  assert(fresh.meta?.risk_approval_execution?.steps?.[0]?.decision === 'PASS', 'expected freshness pass step');

  assert(sell.approved === true && sell.skipped === true, 'expected SELL to skip entry approval guard');
  assert(paper.approved === true && paper.skipped === true, 'expected paper mode to skip entry approval guard');

  return {
    ok: true,
    bypass,
    stale,
    fresh,
    sell,
    paper,
  };
}

async function main() {
  const result = runRiskApprovalExecutionGuardSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('risk approval execution guard smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ risk approval execution guard smoke 실패:',
  });
}
