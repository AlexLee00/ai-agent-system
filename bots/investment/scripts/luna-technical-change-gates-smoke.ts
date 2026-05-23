#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  applyTechnicalExitChangeReview,
  evaluateTechnicalEntryChangeGate,
} from '../shared/technical-change-gates.ts';

function runEntryGateSmoke() {
  const bearishPressure = evaluateTechnicalEntryChangeGate({
    candidate: {
      symbol: 'KITE/USDT',
      action: 'BUY',
      setup_type: 'momentum_rotation',
      indicators: {
        close: 95,
        sma20: 100,
        sma50: 105,
        rsi: 42,
        macdHist: -0.02,
        bbPos: 0.35,
      },
      triggerHints: {
        mtfDominantSignal: 'SELL',
        volumeBurst: 1.2,
      },
    },
  });
  assert.equal(bearishPressure.ok, false);
  assert.equal(bearishPressure.reason, 'technical_bearish_pressure_block');

  const meanReversionMissingRecovery = evaluateTechnicalEntryChangeGate({
    candidate: {
      symbol: 'MEAN/USDT',
      action: 'BUY',
      setup_type: 'mean_reversion',
      indicators: {
        close: 90,
        sma20: 100,
        sma50: 104,
        rsi: 31,
        macdHist: -0.01,
        bbPos: 0.12,
      },
      triggerHints: { mtfDominantSignal: 'SELL', volumeBurst: 1.1 },
    },
  });
  assert.equal(meanReversionMissingRecovery.ok, false);
  assert.equal(meanReversionMissingRecovery.reason, 'technical_mean_reversion_recovery_missing');

  const meanReversionRecovered = evaluateTechnicalEntryChangeGate({
    candidate: {
      symbol: 'MEAN/USDT',
      action: 'BUY',
      setup_type: 'mean_reversion',
      indicators: {
        close: 101,
        sma20: 100,
        sma50: 104,
        rsi: 33,
        macdHist: 0.015,
        bbPos: 0.18,
      },
      triggerHints: { mtfDominantSignal: 'BUY', volumeBurst: 1.4 },
    },
  });
  assert.equal(meanReversionRecovered.ok, true);

  const overboughtChase = evaluateTechnicalEntryChangeGate({
    candidate: {
      symbol: 'HOT/USDT',
      action: 'BUY',
      setup_type: 'momentum_rotation',
      indicators: {
        close: 120,
        sma20: 100,
        sma50: 95,
        rsi: 74,
        macdHist: 0.05,
        bbPos: 0.96,
      },
      triggerHints: {
        mtfDominantSignal: 'BUY',
        volumeBurst: 1.1,
        breakoutRetest: false,
      },
    },
  });
  assert.equal(overboughtChase.ok, false);
  assert.equal(overboughtChase.reason, 'technical_overbought_chase_block');

  const confirmedBreakout = evaluateTechnicalEntryChangeGate({
    candidate: {
      symbol: 'BREAK/USDT',
      action: 'BUY',
      setup_type: 'breakout',
      triggerType: 'breakout_confirmation',
      indicators: {
        close: 120,
        sma20: 100,
        sma50: 95,
        rsi: 74,
        macdHist: 0.05,
        bbPos: 0.96,
      },
      triggerHints: {
        mtfDominantSignal: 'BUY',
        volumeBurst: 2.1,
        breakoutRetest: true,
      },
    },
  });
  assert.equal(confirmedBreakout.ok, true);
}

function runExitReviewSmoke() {
  const recoverySummary = {
    liveIndicator: { compositeSignal: 'HOLD' },
    liveIndicatorFrames: [
      { interval: '1h', signal: 'BUY', rsi: 53, macdHist: 0.02, bbPct: 0.5 },
      { interval: '4h', signal: 'HOLD', rsi: 51, macdHist: 0.01, bbPct: 0.45 },
      { interval: '1d', signal: 'HOLD', rsi: 48, macdHist: -0.01, bbPct: 0.4 },
    ],
  };
  const lossExit = applyTechnicalExitChangeReview({
    recommendation: 'EXIT',
    reasonCode: 'bearish_loss_consensus',
    reason: 'sell pressure',
  }, {
    pnlPct: -1.2,
    heldHours: 2.4,
    analysisSummary: recoverySummary,
  });
  assert.equal(lossExit.decision.recommendation, 'HOLD');
  assert.equal(lossExit.decision.reasonCode, 'technical_loss_exit_recheck_hold');

  const hardStop = applyTechnicalExitChangeReview({
    recommendation: 'EXIT',
    reasonCode: 'stop_loss_threshold',
    reason: 'hard stop',
  }, {
    pnlPct: -5.4,
    heldHours: 0.3,
    analysisSummary: recoverySummary,
  });
  assert.equal(hardStop.decision.recommendation, 'EXIT');

  const dynamicTrailStop = applyTechnicalExitChangeReview({
    recommendation: 'EXIT',
    reasonCode: 'dynamic_trail_stop_breached',
    reason: 'dynamic trail stop breached',
  }, {
    pnlPct: -1.2,
    heldHours: 2.4,
    analysisSummary: recoverySummary,
    dynamicTrail: { breached: true },
  });
  assert.equal(dynamicTrailStop.decision.recommendation, 'EXIT');
  assert.equal(dynamicTrailStop.decision.reasonCode, 'dynamic_trail_stop_breached');

  const profitExit = applyTechnicalExitChangeReview({
    recommendation: 'EXIT',
    reasonCode: 'profit_lock_candidate',
    reason: 'profit lock',
  }, {
    pnlPct: 7.2,
    heldHours: 5,
    analysisSummary: recoverySummary,
  });
  assert.equal(profitExit.decision.recommendation, 'ADJUST');
  assert.equal(profitExit.decision.reasonCode, 'technical_profit_exit_trailing_adjust');

  const profitHold = applyTechnicalExitChangeReview({
    recommendation: 'HOLD',
    reasonCode: 'hold_bias',
    reason: 'hold',
    source: 'reevaluator-smoke',
  }, {
    pnlPct: 8.4,
    heldHours: 4,
    analysisSummary: recoverySummary,
  });
  assert.equal(profitHold.decision.recommendation, 'ADJUST');
  assert.equal(profitHold.decision.reasonCode, 'technical_profit_trailing_candidate');
  assert.equal(profitHold.decision.source, 'reevaluator-smoke');

  const holdNoop = applyTechnicalExitChangeReview({
    recommendation: 'HOLD',
    reasonCode: 'hold_bias',
    reason: 'hold',
    score: 0.77,
  }, {
    pnlPct: 1.2,
    heldHours: 2,
    analysisSummary: recoverySummary,
  });
  assert.equal(holdNoop.decision.recommendation, 'HOLD');
  assert.equal(holdNoop.decision.score, 0.77);
}

async function runSmoke() {
  runEntryGateSmoke();
  runExitReviewSmoke();
  const payload = {
    ok: true,
    smoke: 'luna-technical-change-gates',
    checks: [
      'entry_bearish_pressure_block',
      'entry_overbought_chase_block',
      'mean_reversion_recovery_required',
      'loss_exit_recheck_hold',
      'profit_exit_trailing_adjust',
    ],
  };
  console.log(JSON.stringify(payload, null, 2));
  return payload;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runSmoke,
    errorPrefix: 'luna-technical-change-gates-smoke failed:',
  });
}

export default { runSmoke };
