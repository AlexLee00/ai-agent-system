#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { evaluatePeakDrawdown, nextHighWaterMark } from '../shared/capital-high-water-mark.ts';
import { buildGatedLadderPreview, buildLadderEntryPlan } from '../shared/ladder-entry-planner.ts';
import {
  attachExperimentLedgerToMutation,
  buildExperimentLedgerEvent,
  evaluateExperimentApplyGate,
  recordExperimentLedger,
} from '../shared/experiment-ledger.ts';

assert.equal(nextHighWaterMark(100, 90), 100);
assert.equal(nextHighWaterMark(100, 120), 120);
const peak = evaluatePeakDrawdown({ totalCapital: 89, highWaterMark: 100, maxPeakDrawdownPct: 0.10 });
assert.equal(peak.wouldTrigger, true);
const noPeak = evaluatePeakDrawdown({ totalCapital: 91, highWaterMark: 100, maxPeakDrawdownPct: 0.10 });
assert.equal(noPeak.wouldTrigger, false);

const plan = buildLadderEntryPlan({
  symbol: 'BTC/USDT',
  totalAmount: 90,
  entryPrice: 100,
  steps: 3,
  stepPct: 0.02,
  weights: [0.5, 0.3, 0.2],
});
assert.equal(plan.steps.length, 3);
assert.equal(Math.round(plan.plannedTotal), 90);
assert.equal(plan.exceedsOriginalSizing, false);
assert.equal(plan.steps[1].targetPrice, 98);

const gated = await buildGatedLadderPreview(plan, {
  exchange: 'binance',
  tradeMode: 'normal',
  preTradeCheck: async (symbol, side, amount) => amount > 40
    ? { allowed: false, reason: 'fixture_cap' }
    : { allowed: true },
});
assert.equal(gated.acceptedSteps, 0);
assert.equal(gated.stopped, true);
assert.equal(gated.firstRejectReason, 'fixture_cap');

const ledger = buildExperimentLedgerEvent({
  hypothesis: 'lower pbo improves live expectancy',
  variable: 'pbo_max',
  old: 0.4,
  new: 0.3,
  control_ref: 'control:pbo_default',
  target_metric: 'expectancy',
});
assert.equal(ledger.ok, true);
const invalid = buildExperimentLedgerEvent({
  hypothesis: 'multi variable',
  variables: { a: 1, b: 2 },
  variable: ['a', 'b'],
  target_metric: 'expectancy',
});
assert.equal(invalid.ok, false);
assert.ok(invalid.validation.errors.includes('single_variable_violation'));

const mutation = attachExperimentLedgerToMutation({ mutationType: 'finrl_x_param' }, ledger.payload);
assert.equal(mutation.experimentLedger.eventType, 'experiment_ledger');
const shadowGate = evaluateExperimentApplyGate({
  ledger,
  pboStatus: { wouldBlock: true },
  env: { LUNA_EXPERIMENT_LEDGER_GATE_ENABLED: 'true' },
});
assert.equal(shadowGate.blocked, false);
assert.equal(shadowGate.wouldBlock, true);
const dryRunRecord = await recordExperimentLedger(ledger.payload, { dryRun: true });
assert.equal(dryRunRecord.dryRun, true);

const payload = {
  ok: true,
  smoke: 'luna-loop-state-strategy',
  peakDrawdownWouldTrigger: peak.wouldTrigger,
  ladderSteps: plan.steps.length,
  ledgerEventType: ledger.eventType,
  gateMode: shadowGate.mode,
};

if (process.argv.includes('--json')) console.log(JSON.stringify(payload, null, 2));
else console.log('luna-loop-state-strategy-smoke ok');
