#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { ACTIONS } from '../shared/signal.ts';
import {
  buildCryptoPortfolioFallback,
  buildEmergencyPortfolioFallback,
  buildEmergencySymbolFallbackDecision,
  formatLunaDecisionAmount,
  getStockOrderSpec,
  normalizeDecisionAmount,
} from '../shared/luna-fallback-policy.ts';

const cryptoFallback = buildCryptoPortfolioFallback([
  { symbol: 'BTC/USDT', action: ACTIONS.BUY, confidence: 0.61, reasoning: 'strong trend' },
  { symbol: 'ETH/USDT', action: ACTIONS.BUY, confidence: 0.52, reasoning: 'momentum' },
], {
  positionCount: 0,
  totalAsset: 1_000,
  usdtFree: 240,
  capitalSnapshot: {
    mode: 'ACTIVE_DISCOVERY',
    freeCash: 240,
    remainingSlots: 2,
    minOrderAmount: 11,
    maxBuyAmount: 120,
  },
});
assert.equal(cryptoFallback.source, 'crypto_portfolio_fallback');
assert.equal(cryptoFallback.decisions[0].action, ACTIONS.BUY);
assert.equal(cryptoFallback.decisions[0].amount_usdt <= 220, true);

const blocked = buildCryptoPortfolioFallback([
  { symbol: 'BTC/USDT', action: ACTIONS.BUY, confidence: 0.61 },
], {
  positionCount: 0,
  totalAsset: 1_000,
  usdtFree: 240,
  capitalSnapshot: {
    mode: 'MONITOR_ONLY',
    freeCash: 240,
    remainingSlots: 2,
    minOrderAmount: 11,
  },
});
assert.equal(blocked, null, 'non-active discovery mode should not create fallback BUY');

const emergencyHold = buildEmergencyPortfolioFallback([
  { symbol: 'AAPL', action: ACTIONS.BUY, amount_usdt: 100, confidence: 0.3 },
], { positionCount: 3 }, 'kis_overseas', 'llm_down');
assert.equal(emergencyHold.risk_level, 'HIGH');
assert.equal(emergencyHold.decisions[0].action, ACTIONS.HOLD);

const vote = buildEmergencySymbolFallbackDecision([
  { signal: 'BUY', confidence: 0.5 },
  { signal: 'BUY', confidence: 0.4 },
], 'binance', {
  hasConflict: true,
  recommendation: 'LONG',
  averageConfidence: 0.45,
  fusedScore: 0.2,
});
assert.equal(vote.action, ACTIONS.BUY);
assert.equal(vote.amount_usdt, 100);

const kisSpec = getStockOrderSpec('kis');
assert.equal(Boolean(kisSpec?.buyDefault), true);
assert.equal(normalizeDecisionAmount('kis', ACTIONS.BUY, 1), kisSpec.min);
assert.equal(formatLunaDecisionAmount('kis', 12345), '12,345원');

const payload = {
  ok: true,
  smoke: 'luna-fallback-policy',
  cryptoSource: cryptoFallback.source,
  emergencySource: emergencyHold.source,
  vote,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('luna-fallback-policy-smoke ok');
}
