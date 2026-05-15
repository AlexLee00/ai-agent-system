#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { applyPredictiveValidationGate } from '../shared/predictive-validation-gate.ts';
import { buildPredictiveValidationEvidence } from '../shared/predictive-validation.ts';
import { mergePortfolioDecisionPredictiveEvidence } from '../shared/pipeline-decision-state-machine.ts';
import { promotePredictiveObservationHoldCandidates } from '../shared/pipeline-decision-policy.ts';

const ACTIONS = { BUY: 'BUY', HOLD: 'HOLD' };

export function runLunaPredictiveValidationSmoke() {
  const decisions = [
    { symbol: 'BTC/USDT', action: ACTIONS.BUY, confidence: 0.66, predictiveScore: 0.41, reasoning: 'weak pred' },
    { symbol: 'ETH/USDT', action: ACTIONS.BUY, confidence: 0.74, predictiveScore: 0.76, reasoning: 'strong pred' },
    { symbol: 'SOL/USDT', action: ACTIONS.HOLD, confidence: 0.5, predictiveScore: 0.2, reasoning: 'hold' },
  ];

  const noAudit = { auditLog: false };

  const hard = applyPredictiveValidationGate(decisions, { ...noAudit, mode: 'hard_gate', threshold: 0.55 });
  assert.equal(hard.blocked, 0);
  assert.equal(hard.observation, 1);
  assert.equal(hard.decisions[0].action, ACTIONS.BUY);
  assert.equal(hard.decisions[0].block_meta?.predictiveValidation?.observation, true);
  assert.equal(hard.decisions[1].action, ACTIONS.BUY);

  const discard = applyPredictiveValidationGate([
    { symbol: 'WEAK/USDT', action: ACTIONS.BUY, confidence: 0.66, predictiveScore: 0.19, reasoning: 'discard pred' },
  ], { ...noAudit, mode: 'hard_gate', threshold: 0.55, discardThreshold: 0.40, observationThreshold: 0.40 });
  assert.equal(discard.blocked, 1);
  assert.equal(discard.observation, 0);
  assert.equal(discard.decisions[0].action, ACTIONS.HOLD);

  const mergedPortfolio = mergePortfolioDecisionPredictiveEvidence({
    decisions: [
      { symbol: 'OBS/USDT', action: ACTIONS.BUY, confidence: 0.37, amount_usdt: 80, reasoning: 'portfolio probe' },
    ],
  }, [
    { symbol: 'OBS/USDT', action: ACTIONS.HOLD, confidence: 0.34, predictiveScore: 0.46, block_meta: { scoreFusion: { discoveryScore: 0.42 } } },
  ]);
  assert.equal(mergedPortfolio.decisions[0].action, ACTIONS.BUY);
  assert.equal(mergedPortfolio.decisions[0].predictiveScore, 0.46);
  const mergedHard = applyPredictiveValidationGate(mergedPortfolio.decisions, {
    ...noAudit,
    mode: 'hard_gate',
    threshold: 0.55,
    discardThreshold: 0.40,
    observationThreshold: 0.40,
  });
  assert.equal(mergedHard.blocked, 0);
  assert.equal(mergedHard.observation, 1);
  assert.equal(mergedHard.decisions[0].action, ACTIONS.BUY);

  const rawPredictionHoldBand = applyPredictiveValidationGate([
    { symbol: 'RAWPRED/USDT', action: ACTIONS.BUY, confidence: 0.35, predictiveScore: 0.43, reasoning: 'raw prediction hold band' },
  ], {
    ...noAudit,
    mode: 'hard_gate',
    threshold: 0.55,
    discardThreshold: 0.40,
    observationThreshold: 0.40,
  });
  assert.equal(rawPredictionHoldBand.blocked, 0);
  assert.equal(rawPredictionHoldBand.observation, 1);
  assert.equal(rawPredictionHoldBand.decisions[0].action, ACTIONS.BUY);

  const promotedHold = promotePredictiveObservationHoldCandidates({
    decisions: [
      { symbol: 'LOW/USDT', action: ACTIONS.HOLD, confidence: 0.32, predictiveScore: 0.49, amount_usdt: 80, reasoning: 'too low' },
      { symbol: 'TOP/USDT', action: ACTIONS.HOLD, confidence: 0.42, predictiveScore: 0.49, amount_usdt: 80, reasoning: 'top hold' },
      { symbol: 'SECOND/USDT', action: ACTIONS.HOLD, confidence: 0.40, predictiveScore: 0.50, amount_usdt: 80, reasoning: 'second hold' },
    ],
  }, {
    observationLaneEnabled: true,
    observationThreshold: 0.40,
    threshold: 0.55,
    observationSizeRatio: 0.35,
  }, {
    exchange: 'binance',
    maxPerCycle: 1,
  });
  assert.equal(promotedHold.promoted.length, 1);
  assert.equal(promotedHold.promoted[0].symbol, 'TOP/USDT');
  assert.equal(promotedHold.portfolioDecision.decisions.find((item) => item.symbol === 'TOP/USDT').action, ACTIONS.BUY);
  assert.equal(promotedHold.portfolioDecision.decisions.find((item) => item.symbol === 'SECOND/USDT').action, ACTIONS.HOLD);

  const advisory = applyPredictiveValidationGate(decisions, { ...noAudit, mode: 'advisory', threshold: 0.55 });
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
