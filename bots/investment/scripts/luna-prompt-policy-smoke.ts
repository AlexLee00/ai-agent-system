#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  LUNA_EXIT_SYSTEM,
  buildPortfolioPrompt,
  getLunaSystem,
} from '../shared/luna-prompt-policy.ts';

const deps = {
  stockProfile: {
    promptTag: 'smoke-profile',
    portfolioMaxPositionPct: 0.3,
    portfolioDailyLossPct: 0.1,
  },
  getMinConfidence: () => 0.42,
  getStockOrderSpec: (exchange) => exchange === 'kis'
    ? { min: 100_000, max: 1_000_000, buyDefault: 300_000 }
    : { min: 10, max: 100, buyDefault: 50 },
  formatStockAmountRule: (exchange) => `amount-rule-smoke:${exchange}`,
  maxPosCount: 7,
};

const cryptoSystem = getLunaSystem('binance', deps);
const stockSystem = getLunaSystem('kis', deps);
const overseasSystem = getLunaSystem('kis_overseas', deps);
const portfolioPrompt = buildPortfolioPrompt(['AAPL', 'MSFT'], 'kis_overseas', { closedCount: 1 }, deps);

assert.equal(/amount_usdt 범위: 80~400 USDT/.test(cryptoSystem), true);
assert.equal(stockSystem.includes('smoke-profile'), true);
assert.equal(stockSystem.includes('confidence 0.42'), true);
assert.equal(stockSystem.includes('국내주식(kis) amount_usdt 범위: 100000~1000000'), true);
assert.equal(overseasSystem.includes('해외주식(kis_overseas) amount_usdt 범위: 10~100'), true);
assert.equal(LUNA_EXIT_SYSTEM.includes('SELL 또는 HOLD'), true);
assert.equal(portfolioPrompt.includes('분석 대상 심볼: AAPL, MSFT'), true);
assert.equal(portfolioPrompt.includes('동시 포지션: 최대 7개'), true);
assert.equal(portfolioPrompt.includes('amount-rule-smoke:kis_overseas'), true);
assert.equal(portfolioPrompt.includes('방금 EXIT Phase'), true);

const payload = {
  ok: true,
  smoke: 'luna-prompt-policy',
  cryptoLength: cryptoSystem.length,
  stockLength: stockSystem.length,
  portfolioLength: portfolioPrompt.length,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('luna-prompt-policy-smoke ok');
}
