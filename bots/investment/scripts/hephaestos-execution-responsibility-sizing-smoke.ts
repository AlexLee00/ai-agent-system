#!/usr/bin/env node
// @ts-nocheck

import { applyResponsibilityExecutionSizing } from '../team/hephaestos/execution-responsibility-sizing.ts';

const conservative = applyResponsibilityExecutionSizing(100, {
  action: 'BUY',
  confidence: 0.8,
  responsibilityPlan: {
    ownerMode: 'capital_preservation',
    riskMission: 'strict_risk_gate',
    executionMission: 'precision_execution',
    watchMission: 'risk_sentinel',
  },
  executionPlan: {
    entrySizingMultiplier: 0.8,
  },
});

const opportunity = applyResponsibilityExecutionSizing(100, {
  action: 'BUY',
  confidence: 0.76,
  responsibilityPlan: {
    ownerMode: 'opportunity_capture',
  },
});

const sell = applyResponsibilityExecutionSizing(100, {
  action: 'SELL',
  confidence: 0.9,
  responsibilityPlan: {
    ownerMode: 'capital_preservation',
  },
});

if (!(conservative.amount < 100) || conservative.multiplier !== 0.6368) {
  throw new Error(`conservative sizing mismatch: ${JSON.stringify(conservative)}`);
}
if (opportunity.multiplier !== 1.03 || opportunity.amount !== 103) {
  throw new Error(`opportunity sizing mismatch: ${JSON.stringify(opportunity)}`);
}
if (sell.multiplier !== 1 || sell.amount !== 100 || sell.reason !== null) {
  throw new Error(`sell sizing should be unchanged: ${JSON.stringify(sell)}`);
}

const payload = {
  ok: true,
  smoke: 'hephaestos-execution-responsibility-sizing',
  conservative,
  opportunity,
  sell,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ hephaestos execution responsibility sizing smoke passed');
}
