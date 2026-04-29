#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { applyPredictiveValidationGate } from '../shared/predictive-validation-gate.ts';
import { buildPredictiveValidationEvidence } from '../shared/predictive-validation.ts';

const ACTIONS = { BUY: 'BUY', HOLD: 'HOLD' };

export function runLunaPredictiveValidationSmoke() {
  const decisions = [
    { symbol: 'BTC/USDT', action: ACTIONS.BUY, confidence: 0.66, predictiveScore: 0.41, reasoning: 'weak pred' },
    { symbol: 'ETH/USDT', action: ACTIONS.BUY, confidence: 0.74, predictiveScore: 0.76, reasoning: 'strong pred' },
    { symbol: 'SOL/USDT', action: ACTIONS.HOLD, confidence: 0.5, predictiveScore: 0.2, reasoning: 'hold' },
  ];

  const hard = applyPredictiveValidationGate(decisions, { mode: 'hard_gate', threshold: 0.55 });
  assert.equal(hard.blocked, 1);
  assert.equal(hard.decisions[0].action, ACTIONS.HOLD);
  assert.equal(hard.decisions[1].action, ACTIONS.BUY);

  const advisory = applyPredictiveValidationGate(decisions, { mode: 'advisory', threshold: 0.55 });
  assert.equal(advisory.blocked, 0);
  assert.equal(advisory.advisory, 1);
  assert.equal(advisory.decisions[0].action, ACTIONS.BUY);
  assert.ok(String(advisory.decisions[0].reasoning || '').includes('predictive_advisory'));
  assert.equal(advisory.decisions[0].block_meta?.predictiveValidation?.decision, 'hold');

  const evidence = buildPredictiveValidationEvidence({
    symbol: 'EVIDENCE/USDT',
    action: ACTIONS.BUY,
    confidence: 0.7,
    regime: 'trending_bull',
    backtest: { winRate: 0.62, avgPnlPercent: 2.4, sharpe: 1.1 },
    prediction: { breakout_probability: 0.72, trend_cont_probability: 0.68 },
    analystAccuracy: { aria: 0.63, oracle: 0.61 },
    setupOutcome: { winRate: 0.58, avgPnlPercent: 1.6 },
  }, {}, { threshold: 0.55 });
  assert.equal(evidence.decision, 'fire');
  assert.equal(Object.keys(evidence.components).length, 4);
  assert.ok(evidence.score >= 0.55);

  return {
    ok: true,
    hard,
    advisory,
    evidence,
  };
}

async function main() {
  const result = runLunaPredictiveValidationSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna predictive validation smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna predictive validation smoke 실패:',
  });
}
