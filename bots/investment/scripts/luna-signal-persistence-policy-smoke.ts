#!/usr/bin/env node
// @ts-nocheck

import {
  applyExistingPositionStrategyBias,
  buildLunaRiskEvaluationSignal,
  buildLunaSignalPersistencePlan,
} from '../shared/luna-signal-persistence-policy.ts';

const baseSignal = {
  symbol: 'ORCA/USDT',
  action: 'BUY',
  amountUsdt: 100,
  confidence: 0.8,
  reasoning: 'smoke',
  tradeMode: 'normal',
};

const biased = applyExistingPositionStrategyBias(baseSignal, {
  id: 7,
  setup_type: 'breakout',
  strategy_state: { lifecycleStatus: 'holding' },
  responsibilityPlan: { ownerMode: 'capital_preservation' },
  executionPlan: { entrySizingMultiplier: 0.8 },
});

const riskSignal = buildLunaRiskEvaluationSignal(baseSignal);
const approved = buildLunaSignalPersistencePlan(baseSignal, {
  approved: true,
  adjustedAmount: 72,
  nemesis_verdict: 'approved',
}, null, {
  exchange: 'binance',
  decision: { amount_usdt: 100, confidence: 0.8 },
});
const rejected = buildLunaSignalPersistencePlan(baseSignal, {
  approved: false,
  reason: 'risk_too_high',
  adjustedAmount: 0,
}, null, {
  exchange: 'binance',
  decision: { amount_usdt: 100 },
});
const failed = buildLunaSignalPersistencePlan(baseSignal, null, new Error('nemesis down'), {
  exchange: 'binance',
  decision: { amount_usdt: 100 },
});

if (!biased.applied || biased.signalData.amountUsdt !== 88 || !biased.signalData.existingExecutionPlan) {
  throw new Error(`existing position bias mismatch: ${JSON.stringify(biased)}`);
}
if (riskSignal.amount_usdt !== 100 || riskSignal.trade_mode !== 'normal') {
  throw new Error(`risk signal mismatch: ${JSON.stringify(riskSignal)}`);
}
if (approved.outcome !== 'approved' || approved.signalData.amountUsdt !== 72 || !approved.approvalUpdate) {
  throw new Error(`approved persistence mismatch: ${JSON.stringify(approved)}`);
}
if (rejected.outcome !== 'rejected' || rejected.blockUpdate?.code !== 'risk_rejected') {
  throw new Error(`rejected persistence mismatch: ${JSON.stringify(rejected)}`);
}
if (failed.outcome !== 'failed' || failed.blockUpdate?.code !== 'nemesis_error') {
  throw new Error(`failed persistence mismatch: ${JSON.stringify(failed)}`);
}

const payload = {
  ok: true,
  smoke: 'luna-signal-persistence-policy',
  biasedAmount: biased.signalData.amountUsdt,
  approvedStatus: approved.status,
  rejectedStatus: rejected.status,
  failedStatus: failed.status,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ luna signal persistence policy smoke passed');
}
