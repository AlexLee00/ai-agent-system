#!/usr/bin/env node
// @ts-nocheck

import assert from 'assert/strict';
import { createRiskAndCapitalGatePolicy } from '../team/hephaestos/risk-and-capital-gates.ts';

const persistCalls = [];
const skipCalls = [];
const preTradeCallArgs = [];
const livePositionCallArgs = [];
const openPositionCallArgs = [];
const positionSizeCallArgs = [];
const minOrderCallArgs = [];
let preTradeCalls = 0;

function buildPolicy({
  firstCheck,
  validationCheck = { allowed: true },
  sizing = { skip: false, size: 50, capitalPct: 5, riskPercent: 1 },
  byExchange = null,
} = {}) {
  preTradeCalls = 0;
  persistCalls.length = 0;
  skipCalls.length = 0;
  preTradeCallArgs.length = 0;
  livePositionCallArgs.length = 0;
  openPositionCallArgs.length = 0;
  positionSizeCallArgs.length = 0;
  minOrderCallArgs.length = 0;
  return createRiskAndCapitalGatePolicy({
    getInvestmentExecutionRuntimeConfig: () => ({
      cryptoGuardSoftening: {
        byExchange: byExchange || {
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
    preTradeCheck: async (symbol, side, amount, exchange, mode) => {
      preTradeCalls += 1;
      preTradeCallArgs.push({ symbol, side, amount, exchange, mode });
      return mode === 'validation' ? validationCheck : firstCheck;
    },
    db: {
      updateSignalBlock: async () => {},
    },
    notifyTradeSkip: async (payload) => {
      skipCalls.push(payload);
    },
    getOpenPositions: async (exchange, paper, mode) => {
      openPositionCallArgs.push({ exchange, paper, mode });
      return [{ symbol: 'OLD/USDT' }];
    },
    findAnyLivePosition: async (symbol, exchange) => {
      livePositionCallArgs.push({ symbol, exchange });
      return null;
    },
    fetchTicker: async () => 10,
    calculatePositionSize: async (symbol, currentPrice, slPrice, exchange) => {
      positionSizeCallArgs.push({ symbol, currentPrice, slPrice, exchange });
      return sizing;
    },
    getDynamicMinOrderAmount: async (exchange, mode) => {
      minOrderCallArgs.push({ exchange, mode });
      return 10;
    },
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
assert.equal(preTradeCallArgs[0]?.exchange, 'binance');
assert.equal(preTradeCallArgs[0]?.mode, 'normal');
const shortageCode = persistCalls[0]?.meta?.code;

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

const missingKisPolicy = buildPolicy({
  firstCheck: { allowed: false, circuit: false, reason: '최대 포지션 도달: 5/5' },
  byExchange: {
    binance: {
      tradeModes: {
        normal: {
          validationFallback: {
            enabled: true,
            allowedGuardKinds: ['max_positions'],
            reductionMultiplier: 0.5,
          },
        },
      },
    },
  },
});
const kisNoFallback = await missingKisPolicy.resolveBuyExecutionMode({
  persistFailure: async (reason, meta) => persistCalls.push({ reason, meta }),
  signalId: 'sig-kis-no-fallback',
  symbol: '005930',
  action: 'BUY',
  amountUsdt: 100000,
  signalTradeMode: 'normal',
  globalPaperMode: false,
  capitalPolicy: { max_concurrent_positions: 5 },
  exchange: 'kis',
});
assert.equal(kisNoFallback.success, false);
assert.equal(preTradeCallArgs[0]?.exchange, 'kis');
assert.equal(preTradeCalls, 1, 'kis without byExchange.kis must not attempt validation fallback');

const kisPolicy = buildPolicy({
  firstCheck: { allowed: false, circuit: false, reason: '최대 포지션 도달: 5/5' },
  validationCheck: { allowed: true, softGuards: [{ kind: 'kis_validation_guard' }] },
  byExchange: {
    kis: {
      tradeModes: {
        normal: {
          validationFallback: {
            enabled: true,
            allowedGuardKinds: ['max_positions'],
            reductionMultiplier: 0.25,
          },
        },
      },
    },
  },
});
const kisFallback = await kisPolicy.resolveBuyExecutionMode({
  persistFailure: async () => {},
  signalId: 'sig-kis-fallback',
  symbol: '005930',
  action: 'BUY',
  amountUsdt: 100000,
  signalTradeMode: 'normal',
  globalPaperMode: false,
  capitalPolicy: { max_concurrent_positions: 5 },
  exchange: 'kis',
});
assert.equal(kisFallback.effectiveTradeMode, 'validation');
assert.equal(kisFallback.reducedAmountMultiplier, 0.25);
assert.equal(kisFallback.softGuards[0]?.exchange, 'kis');
assert.equal(livePositionCallArgs[0]?.exchange, 'kis');
assert.equal(preTradeCallArgs[1]?.exchange, 'kis');
assert.equal(preTradeCallArgs[1]?.mode, 'validation');

process.env.LUNA_MAX_TRADE_USDT = '50';
process.env.LUNA_MAX_TRADE_USDT_KIS = '100000';
const kisSizingPolicy = buildPolicy({
  firstCheck: { allowed: true },
  sizing: { skip: false, size: 120000, capitalPct: 12, riskPercent: 2 },
});
assert.equal(kisSizingPolicy.getLiveFireMaxTradeUsdt('kis'), 100000);
assert.equal(kisSizingPolicy.getLiveFireMaxTradeUsdt('binance'), 50);
const kisOrderAmount = await kisSizingPolicy.resolveBuyOrderAmount({
  persistFailure: async () => {},
  symbol: '005930',
  action: 'BUY',
  amountUsdt: 120000,
  signal: { trade_mode: 'normal', slPrice: 90000 },
  effectivePaperMode: false,
  exchange: 'kis',
});
assert.equal(kisOrderAmount.actualAmount, 100000);
assert.equal(kisOrderAmount.liveFireCapApplied, true);
assert.equal(positionSizeCallArgs[0]?.exchange, 'kis');
assert.equal(minOrderCallArgs[0]?.exchange, 'kis');
delete process.env.LUNA_MAX_TRADE_USDT;
delete process.env.LUNA_MAX_TRADE_USDT_KIS;

const overflowCompatPolicy = buildPolicy({
  byExchange: {
    binance: {
      tradeModes: {
        paper_data: { maxPositions: { marker: 'paper_data' } },
      },
    },
    kis: {
      tradeModes: {
        normal: { maxPositions: { marker: 'kis_normal' } },
      },
    },
  },
});
assert.equal(overflowCompatPolicy.getMaxPositionsOverflowPolicy('paper_data').marker, 'paper_data');
assert.equal(overflowCompatPolicy.getMaxPositionsOverflowPolicy('kis').marker, 'kis_normal');

const payload = {
  ok: true,
  smoke: 'hephaestos-risk-and-capital-gates',
  shortageCode,
  fallbackTradeMode: fallback.effectiveTradeMode,
  orderAmount: orderAmount.actualAmount,
  cappedOrderAmount: cappedOrderAmount.actualAmount,
  kisNoFallbackSuccess: kisNoFallback.success,
  kisFallbackTradeMode: kisFallback.effectiveTradeMode,
  kisCappedOrderAmount: kisOrderAmount.actualAmount,
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('✅ hephaestos risk/capital gate smoke passed');
}
