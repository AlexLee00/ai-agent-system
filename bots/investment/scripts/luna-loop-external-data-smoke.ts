#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { createTossClient } from '../shared/brokers/toss-client.ts';
import { createTossBrokerAdapter } from '../shared/brokers/toss-adapter.ts';
import { kisBrokerAdapter } from '../shared/brokers/kis-adapter.ts';
import { callMarketdataTool, MARKETDATA_MCP_TOOLS } from '../mcp/luna-marketdata-mcp/src/server.ts';
import { createHephaestosSignalExecutor } from '../team/hephaestos/signal-executor.ts';

const requests = [];
function jsonResponse(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(payload) };
}

const client = createTossClient({
  credentialsProvider: async () => ({ apiKey: 'test-key', secretKey: 'test-secret' }),
  sleepFn: async () => {},
  nowFn: () => 0,
  fetchFn: async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).includes('/oauth2/token')) {
      return jsonResponse({ access_token: 'token', expires_in: 3600 });
    }
    if (String(url).includes('/api/v1/orderbook')) {
      return jsonResponse({ result: { bids: [{ price: 1 }], asks: [{ price: 2 }] } });
    }
    if (String(url).includes('/api/v1/trades')) {
      return jsonResponse({ result: { trades: [{ price: 1, quantity: 3 }] } });
    }
    if (String(url).includes('/api/v1/stocks/')) {
      return jsonResponse({ result: { symbol: '005930', name: '삼성전자', market: 'domestic' } });
    }
    return jsonResponse({ result: {} });
  },
});

const orderbook = await client.getOrderBook('005930');
assert.equal(orderbook.bids.length, 1);
const trades = await client.getTrades('005930');
assert.equal(trades.trades.length, 1);
const master = await client.getStockMaster('005930');
assert.equal(master.symbol, '005930');
assert.ok(requests.every((req) => req.options?.method === 'GET' || String(req.url).includes('/oauth2/token')), 'toss data endpoints must be GET/read-only');

const adapter = createTossBrokerAdapter({ client });
assert.equal((await adapter.getOrderBook('005930')).symbol, '005930');
assert.equal(kisBrokerAdapter.capabilities.canTrade, false);
await assert.rejects(() => kisBrokerAdapter.placeOrder({ symbol: '005930' }), /broker_execution_disabled/);

const toolNames = MARKETDATA_MCP_TOOLS.map((tool) => tool.name);
assert.ok(toolNames.includes('get_toss_orderbook'));
assert.ok(toolNames.includes('get_toss_trades'));
assert.ok(toolNames.includes('get_toss_stock_master'));

const unknown = await callMarketdataTool('get_toss_stock_master', { symbol: '' });
assert.equal(unknown.readOnly, true);

let marketBuyCalled = false;
const executor = createHephaestosSignalExecutor({
  ACTIONS: { BUY: 'BUY', SELL: 'SELL' },
  SIGNAL_STATUS: { FAILED: 'failed' },
  db: {},
  initHubSecrets: async () => true,
  isPaperMode: () => true,
  getInvestmentTradeMode: () => 'normal',
  getCapitalConfig: async () => ({}),
  getDynamicMinOrderAmount: async () => 10,
  buildHephaestosExecutionPreflight: async (signal) => ({
    globalPaperMode: true,
    signalTradeMode: signal.trade_mode || 'normal',
    capitalPolicy: { max_concurrent_positions: 3, max_daily_trades: 5 },
    minOrderUsdt: 10,
    executionContext: {
      signalId: signal.id,
      symbol: signal.symbol,
      action: signal.action,
      base: signal.symbol,
      tag: 'smoke',
      amountUsdt: signal.amount_usdt,
      effectivePaperMode: true,
      exchange: signal.exchange,
    },
  }),
  buildExecutionRiskApprovalGuard: () => ({ approved: true }),
  notifyTradeSkip: async () => {},
  normalizePartialExitRatio: () => null,
  buildSignalQualityContext: () => ({}),
  getInvestmentAgentRoleState: async () => null,
  createSignalFailurePersister: () => async () => {},
  isBinanceSymbol: () => false,
  maybePromotePaperPositions: async () => [],
  runBuySafetyGuards: async () => null,
  checkCircuitBreaker: async () => ({ triggered: false }),
  getOpenPositions: async () => [],
  getMaxPositionsOverflowPolicy: () => ({}),
  getDailyTradeCount: async () => 0,
  formatDailyTradeLimitReason: () => 'daily limit',
  tryAbsorbUntrackedBalance: async () => null,
  checkBuyReentryGuards: async () => ({ success: true }),
  _tryBuyWithBtcPair: async () => null,
  shouldBlockUsdtFallbackAfterBtcPairError: () => false,
  liquidateUntrackedForCapital: async () => {},
  resolveBuyExecutionMode: async (input) => {
    assert.equal(input.exchange, 'kis');
    return { success: true, effectivePaperMode: true, effectiveTradeMode: 'normal', softGuards: [] };
  },
  rejectExecution: (payload) => ({ success: false, ...payload }),
  resolveBuyOrderAmount: async (input) => {
    assert.equal(input.exchange, 'kis');
    return { success: true, actualAmount: 100000 };
  },
  applyResponsibilityExecutionSizing: (amount) => ({ amount, multiplier: 1, reason: null }),
  buildDeterministicClientOrderId: () => 'unused',
  marketBuy: async () => {
    marketBuyCalled = true;
    throw new Error('marketBuy should not run for kis shadow');
  },
  persistBuyPosition: async () => {},
  attachExecutionToPositionStrategyTracked: async () => {},
  syncCryptoStrategyExecutionState: async () => {},
  applyBuyProtectiveExit: async () => {},
  resolveSellExecutionContext: async () => ({}),
  resolveSellAmount: async () => ({}),
  executeSellTrade: async () => ({}),
  finalizeExecutedTrade: async () => ({}),
  binanceExecutionReconcileHandler: {},
  notifyError: async () => {},
  recordPositionLifecycleStageEvent: async () => null,
});
const kisShadow = await executor.executeSignal({
  id: 'kis-smoke',
  symbol: '005930',
  action: 'BUY',
  amount_usdt: 100000,
  exchange: 'kis',
  market: 'domestic',
});
assert.equal(kisShadow.exchange, 'kis');
assert.equal(kisShadow.orderSubmitted, false);
assert.equal(kisShadow.liveMutation, false);
assert.equal(marketBuyCalled, false);

const payload = { ok: true, smoke: 'luna-loop-external-data', tossRequests: requests.length, tools: toolNames.filter((name) => name.startsWith('get_toss_')).length, kisShadowOrderSubmitted: kisShadow.orderSubmitted };
if (process.argv.includes('--json')) console.log(JSON.stringify(payload, null, 2));
else console.log('luna-loop-external-data-smoke ok');
