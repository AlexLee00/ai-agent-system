#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildClosedSiblingResidualPlan,
  buildFilledProtectionJournalDriftRepairPlan,
  buildOpenProtectionJournalRestorePlan,
  buildProtectiveOrderJournalCloseInput,
  classifyProtectiveOrderJournalRepair,
  summarizeProtectiveOrderJournalRepair,
} from './reconcile-protective-order-journals.ts';

const entry = {
  trade_id: 'TRD-SMOKE-001',
  symbol: 'APE/USDT',
  entry_size: 754.42,
  entry_value: 115.875,
};

const filledStop = classifyProtectiveOrderJournalRepair({
  entry,
  tpOrder: { id: 'tp-1', status: 'expired', side: 'sell', filled: 0, amount: 754.42 },
  slOrder: {
    id: 'sl-1',
    status: 'closed',
    side: 'sell',
    filled: 753.66,
    amount: 754.42,
    average: 0.16,
    cost: 120.5856,
    timestamp: 1770000000000,
  },
});
assert.equal(filledStop.action, 'close_from_protective_order');
assert.equal(filledStop.closeSafe, true);
assert.equal(filledStop.winningRole, 'stop_loss');

const closeInput = buildProtectiveOrderJournalCloseInput(entry, filledStop);
assert.equal(closeInput.exitReason, 'protective_order_reconciled:stop_loss');
assert.equal(closeInput.exitValue, 120.5856);
assert.equal(closeInput.execution_origin, 'reconciliation');
assert.equal(closeInput.quality_flag, 'trusted');

const stillOpen = classifyProtectiveOrderJournalRepair({
  entry,
  tpOrder: { id: 'tp-open', status: 'open', side: 'sell', filled: 0, amount: 754.42 },
  slOrder: { id: 'sl-open', status: 'open', side: 'sell', filled: 0, amount: 754.42 },
});
assert.equal(stillOpen.action, 'observe_open_protection');
assert.equal(stillOpen.closeSafe, false);

const ambiguous = classifyProtectiveOrderJournalRepair({
  entry,
  tpOrder: { id: 'tp-filled', status: 'closed', side: 'sell', filled: 754.42, amount: 754.42 },
  slOrder: { id: 'sl-filled', status: 'closed', side: 'sell', filled: 754.42, amount: 754.42 },
});
assert.equal(ambiguous.action, 'manual_ambiguous_multiple_filled_protective_orders');
assert.equal(ambiguous.manualOnly, true);

const partial = classifyProtectiveOrderJournalRepair({
  entry,
  slOrder: { id: 'sl-partial', status: 'closed', side: 'sell', filled: 300, amount: 754.42 },
});
assert.equal(partial.action, 'manual_partial_protective_fill');
assert.equal(partial.closeSafe, false);

const driftRepairPlan = buildFilledProtectionJournalDriftRepairPlan({
  entry: { ...entry, entry_size: 0.00336, entry_value: 0.000516096, entry_price: 0.1536 },
  decision: {
    ...partial,
    winningRole: 'take_profit',
    orders: [
      {
        role: 'take_profit',
        id: 'tp-drift',
        status: 'closed',
        side: 'sell',
        filled: 799.65,
        amount: 799.65,
        average: 0.15,
        cost: 119.9475,
        timestamp: 1777448999355,
      },
    ],
  },
});
assert.equal(driftRepairPlan.action, 'restore_and_close_from_filled_protection_after_journal_drift');
assert.equal(driftRepairPlan.closeSafe, true);
assert.equal(driftRepairPlan.restoreBeforeClose, true);
assert.ok(driftRepairPlan.afterEntrySize > 799);

const summary = summarizeProtectiveOrderJournalRepair([
  { tradeId: 'a', ...filledStop },
  { tradeId: 'b', ...stillOpen },
  { tradeId: 'c', ...ambiguous },
]);
assert.equal(summary.candidates, 1);
assert.equal(summary.manual, 1);
assert.equal(summary.byAction.close_from_protective_order, 1);

const restorePlan = buildOpenProtectionJournalRestorePlan({
  entry: { ...entry, entry_size: 0.00336, entry_value: 0.000516096, entry_price: 0.1536 },
  decision: {
    ...stillOpen,
    orders: stillOpen.orders.map((order) => ({ ...order, amount: 799.65 })),
  },
  position: { amount: 799.65336, avg_price: 0.1536 },
});
assert.equal(restorePlan.action, 'restore_open_journal_from_open_protection');
assert.equal(restorePlan.restoreSafe, true);
assert.ok(restorePlan.afterEntrySize > 799);

const residualPlan = buildClosedSiblingResidualPlan({
  entry: { ...entry, entry_size: 0.81 },
  decision: {
    action: 'observe_unfilled_terminal_protection',
  },
  closedSibling: { trade_id: 'TRD-CLOSED-SIBLING', entry_size: 812.99, exit_reason: 'normal_exit' },
});
assert.equal(residualPlan.action, 'close_residual_from_closed_sibling');
assert.equal(residualPlan.closeSafe, true);

const payload = {
  ok: true,
  smoke: 'reconcile-protective-order-journals',
  filledStop,
  stillOpen,
  ambiguous,
  partial,
  driftRepairPlan,
  restorePlan,
  residualPlan,
  summary,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('reconcile-protective-order-journals-smoke ok');
}
