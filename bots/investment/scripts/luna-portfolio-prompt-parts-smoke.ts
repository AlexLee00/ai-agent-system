#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { ACTIONS } from '../shared/signal.ts';
import { buildPortfolioDecisionPromptParts } from '../shared/luna-portfolio-prompt-parts.ts';

const parts = await buildPortfolioDecisionPromptParts([
  {
    symbol: 'BTC/USDT',
    action: ACTIONS.BUY,
    confidence: 0.72,
    reasoning: 'breakout',
    strategy_route: {
      selectedFamily: 'breakout',
      quality: 'good',
      readinessScore: 0.81,
    },
  },
  {
    symbol: 'ETH/USDT',
    action: ACTIONS.HOLD,
    confidence: 0.42,
    reasoning: 'wait',
  },
], {
  usdtFree: 123.45,
  totalAsset: 456.78,
  positionCount: 2,
  todayPnl: { pnl: -1.23 },
}, 'binance', {
  closedCount: 1,
  reclaimedUsdt: 12.5,
  closedPositions: [{ symbol: 'SOL/USDT', reason: 'take profit', reclaimedUsdt: 12.5 }],
}, {
  maxPosCount: 7,
  buildPortfolioPrompt: (symbols, exchange, exitSummary) => `system:${exchange}:${symbols.join('|')}:${exitSummary?.closedCount || 0}`,
});

assert.deepEqual(parts.symbols, ['BTC/USDT', 'ETH/USDT']);
assert.equal(parts.systemPrompt, 'system:binance:BTC/USDT|ETH/USDT:1');
assert.equal(parts.userMsg.includes('현재 포지션: 2/7개'), true);
assert.equal(parts.userMsg.includes('BTC/USDT: BUY | 확신도 72% | 전략 breakout/good(0.81)'), true);
assert.equal(parts.userMsg.includes('방금 1개 포지션을 청산했습니다.'), true);
assert.equal(parts.userMsg.includes('- SOL/USDT: take profit | 회수 $12.50'), true);
assert.equal(parts.userMsg.includes('최종 포트폴리오 투자 결정:'), true);

const payload = {
  ok: true,
  smoke: 'luna-portfolio-prompt-parts',
  symbols: parts.symbols,
  userMsgLength: parts.userMsg.length,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('luna-portfolio-prompt-parts-smoke ok');
}
