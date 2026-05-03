#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { createRiskAndCapitalGatePolicy } from '../team/hephaestos/risk-and-capital-gates.ts';

const persistCalls = [];
const skipCalls = [];
let preTradeCalls = 0;

function buildPolicy({ firstCheck, validationCheck = { allowed: true }, sizing = { skip: false, size: 50, capitalPct: 5, riskPercent: 1 } } = {}) {
  preTradeCalls = 0;
  persistCalls.length = 0;
  skipCalls.length = 0;
  return createRiskAndCapitalGatePolicy({
    getInvestmentExecutionRuntimeConfig: () => ({
      cryptoGuardSoftening: {
        byExchange: {
          binance: {
            tradeModes: {
              normal: {
                validationFallback: {
                  enabled: true,
                  allowedGuardKinds: ['max_positions', 'daily_trade_limit'],
                  reductionMultiplier: 0.5,
                },
              },
              validation: {
                livePositionReentry: {
                  enabled: true,
                  reductionMultiplier: 0.4,
                },
              },
            },
          },
        },
      },
    }),
    preTradeCheck: async (_symbol, _side, _amount, _exchange, mode) => {
      preTradeCalls += 1;
      return mode === 'validation' ? validationCheck : firstCheck;
    },
    db: {
      updateSignalBlock: async () => {},
    },
    notifyTradeSkip: async (payload) => {
      skipCalls.push(payload);
    },
    getOpenPositions: async () => [{ symbol: 'OLD/USDT' }],
    findAnyLivePosition: async () => null,
    fetchTicker: async () => 10,
    calculatePositionSize: async () => sizing,
    getDynamicMinOrderAmount: async () => 10,
    getInvestmentTradeMode: () => 'normal',
  });
}

const shortagePolicy = buildPolicy({
  firstCheck: { allowed: false, circuit: false, reason: '잔고 부족: available USDT too low' },
});
const shortage = await shortagePolicy.resolveBuyExecutionMode({
  persistFailure: async (reason, meta) => persistCalls.push({ reason, meta }),
  signalId: 'sig-short',
  symbol: 'ORCA/USDT',
  action: 'BUY',
  amountUsdt: 100,
  signalTradeMode: 'normal',
  globalPaperMode: false,
  capitalPolicy: { max_concurrent_positions: 5 },
});
assert.equal(shortage.success, false);
assert.equal(persistCalls[0]?.meta?.code, 'capital_backpressure');

const fallbackPolicy = buildPolicy({
  firstCheck: { allowed: false, circuit: false, reason: '최대 포지션 도달: 5/5' },
  validationCheck: { allowed: true, softGuards: [{ kind: 'validation_guard' }] },
});
const fallback = await fallbackPolicy.resolveBuyExecutionMode({
  persistFailure: async () => {},
  signalId: 'sig-fallback',
  symbol: 'APE/USDT',
  action: 'BUY',
  amountUsdt: 100,
  signalTradeMode: 'normal',
  globalPaperMode: false,
  capitalPolicy: { max_concurrent_positions: 5 },
});
assert.equal(fallback.effectiveTradeMode, 'validation');
assert.equal(fallback.reducedAmountMultiplier, 0.5);
assert.equal(fallback.softGuardApplied, true);

const sizingPolicy = buildPolicy({
  firstCheck: { allowed: true },
  sizing: { skip: false, size: 80, capitalPct: 8, riskPercent: 1.5 },
});
const orderAmount = await sizingPolicy.resolveBuyOrderAmount({
  persistFailure: async () => {},
  symbol: 'MASK/USDT',
  action: 'BUY',
  amountUsdt: 100,
  signal: { trade_mode: 'normal', slPrice: 8 },
  effectivePaperMode: false,
  reducedAmountMultiplier: 0.5,
  softGuards: [{ kind: 'smoke_guard' }],
});
assert.equal(orderAmount.actualAmount, 40);

process.env.LUNA_MAX_TRADE_USDT = '50';
const cappedPolicy = buildPolicy({
  firstCheck: { allowed: true },
  sizing: { skip: false, size: 120, capitalPct: 12, riskPercent: 2 },
});
const cappedOrderAmount = await cappedPolicy.resolveBuyOrderAmount({
  persistFailure: async () => {},
  symbol: 'SOL/USDT',
  action: 'BUY',
  amountUsdt: 120,
  signal: { trade_mode: 'normal', slPrice: 90 },
  effectivePaperMode: false,
});
assert.equal(cappedOrderAmount.actualAmount, 50);
assert.equal(cappedOrderAmount.liveFireCapApplied, true);
delete process.env.LUNA_MAX_TRADE_USDT;

const payload = {
  ok: true,
  smoke: 'hephaestos-risk-and-capital-gates',
  shortageCode: persistCalls[0]?.meta?.code,
  fallbackTradeMode: fallback.effectiveTradeMode,
  orderAmount: orderAmount.actualAmount,
  cappedOrderAmount: cappedOrderAmount.actualAmount,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ hephaestos risk/capital gate smoke passed');
}
