#!/usr/bin/env node
// @ts-nocheck

import * as legacy from '../team/hephaestos.ts';
import * as pendingReconcile from '../team/hephaestos/pending-reconcile.ts';
import * as journalRepair from '../team/hephaestos/journal-repair.ts';
import * as pendingRetry from '../team/hephaestos/pending-retry.ts';
import { buildHephaestosExecutionContext } from '../team/hephaestos/execution-context.ts';

const context = buildHephaestosExecutionContext({
  id: 'smoke-signal',
  symbol: 'BTC/USDT',
  action: 'BUY',
  amount_usdt: 42,
  trade_mode: 'validation',
}, {
  globalPaperMode: true,
  defaultTradeMode: 'normal',
});

const checks = [
  ['buildBinancePendingReconcilePayload', pendingReconcile.buildBinancePendingReconcilePayload === legacy.buildBinancePendingReconcilePayload],
  ['processBinancePendingReconcileQueue', pendingReconcile.processBinancePendingReconcileQueue === legacy.processBinancePendingReconcileQueue],
  ['processBinancePendingJournalRepairQueue', journalRepair.processBinancePendingJournalRepairQueue === legacy.processBinancePendingJournalRepairQueue],
  ['enqueueClientOrderPendingRetry', pendingRetry.enqueueClientOrderPendingRetry === legacy.enqueueClientOrderPendingRetry],
  ['executionContext.amount', context.amountUsdt === 42],
  ['executionContext.base', context.base === 'BTC'],
  ['executionContext.tradeMode', context.signalTradeMode === 'validation'],
  ['executionContext.tag', context.tag === '[PAPER]'],
];

const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
  throw new Error(`hephaestos submodule export mismatch: ${failed.map(([name]) => name).join(', ')}`);
}

const payload = {
  ok: true,
  smoke: 'hephaestos-module-exports',
  checks: Object.fromEntries(checks),
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ hephaestos module export smoke passed');
}
