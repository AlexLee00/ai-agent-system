#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { ACTIONS, ANALYST_TYPES } from '../shared/signal.ts';
import {
  applyExitGuard,
  buildCompactExitAnalystSummary,
  buildExitFallback,
  buildExitPrompt,
  getPositionPnlPct,
  normalizeExitDecision,
  normalizeExitDecisionResult,
} from '../shared/luna-exit-policy.ts';

const position = {
  symbol: 'ORCA/USDT',
  amount: 10,
  avg_price: 10,
  current_price: 9.95,
  unrealized_pnl: -0.5,
  held_hours: 2,
  trade_mode: 'validation',
  analyses: [
    { analyst: ANALYST_TYPES.TA_MTF, signal: 'BUY', confidence: 0.7, reasoning: 'trend still valid' },
    { analyst: ANALYST_TYPES.NEWS, signal: 'HOLD', confidence: 0.4, reasoning: 'mixed news' },
  ],
};

const summary = buildCompactExitAnalystSummary(position.analyses);
assert.equal(summary.includes('[TA] BUY 70%'), true);
assert.equal(summary.includes('[뉴스] HOLD 40%'), true);

const prompt = buildExitPrompt([position], 'binance');
assert.equal(prompt.includes('시장: 암호화폐 (binance)'), true);
assert.equal(prompt.includes('분석가 집계: BUY 1 / HOLD 1 / SELL 0'), true);

const normalized = normalizeExitDecision({ symbol: 'ORCA/USDT', action: 'SELL', confidence: 9, reasoning: 'x' }, position);
assert.equal(normalized.action, ACTIONS.SELL);
assert.equal(normalized.confidence, 1);

assert.equal(Number(getPositionPnlPct(position).toFixed(2)), -0.5);

const guarded = applyExitGuard(position, normalized);
assert.equal(guarded.action, ACTIONS.HOLD);
assert.equal(guarded.reasoning.includes('EXIT 가드'), true);

const fallback = buildExitFallback([
  { symbol: 'OLD/USDT', avg_price: 10, current_price: 11, held_hours: 80, analyses: [] },
  { symbol: 'LOSS/USDT', avg_price: 10, current_price: 9.4, held_hours: 1, analyses: [] },
]);
assert.equal(fallback.decisions[0].action, ACTIONS.SELL);
assert.equal(fallback.decisions[1].action, ACTIONS.SELL);

const normalizedResult = normalizeExitDecisionResult({
  decisions: [{ symbol: 'ORCA/USDT', action: 'SELL', confidence: 0.8, reasoning: 'tiny loss' }],
  exit_view: 'smoke',
}, [position, { ...position, symbol: 'MISSING/USDT' }]);
assert.equal(normalizedResult.decisions.length, 2);
assert.equal(normalizedResult.decisions.find((item) => item.symbol === 'MISSING/USDT')?.action, ACTIONS.HOLD);

const payload = {
  ok: true,
  smoke: 'luna-exit-policy',
  guarded,
  fallback,
  normalizedResult,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('luna-exit-policy-smoke ok');
}
