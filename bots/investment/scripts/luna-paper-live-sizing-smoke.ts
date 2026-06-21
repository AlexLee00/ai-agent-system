#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { createRiskAndCapitalGatePolicy } from '../team/hephaestos/risk-and-capital-gates.ts';

function buildPolicy({
  sizing = { skip: false, size: 80, capitalPct: 8, riskPercent: 1.2 },
  minOrderUsdt = 10,
} = {}) {
  const persistCalls = [];
  const policy = createRiskAndCapitalGatePolicy({
    getInvestmentExecutionRuntimeConfig: () => ({}),
    preTradeCheck: async () => ({ allowed: true }),
    db: { updateSignalBlock: async () => {} },
    notifyTradeSkip: async () => {},
    getOpenPositions: async () => [],
    findAnyLivePosition: async () => null,
    fetchTicker: async () => 10,
    calculatePositionSize: async () => sizing,
    getDynamicMinOrderAmount: async () => minOrderUsdt,
    getInvestmentTradeMode: () => 'normal',
  });
  return { policy, persistCalls };
}

async function resolve(policy, overrides = {}) {
  const persistCalls = overrides.persistCalls || [];
  return policy.resolveBuyOrderAmount({
    persistFailure: async (reason, meta) => {
      persistCalls.push({ reason, meta });
      return { success: false, reason, meta };
    },
    symbol: 'MASK/USDT',
    action: 'BUY',
    amountUsdt: 300,
    signal: { trade_mode: 'normal', slPrice: 8 },
    effectivePaperMode: false,
    ...overrides,
  });
}

export async function runLunaPaperLiveSizingSmoke() {
  const liveFixture = buildPolicy({ sizing: { skip: false, size: 80, capitalPct: 8, riskPercent: 1.2 } });
  const live = await resolve(liveFixture.policy, { effectivePaperMode: false });
  const paperFixture = buildPolicy({ sizing: { skip: false, size: 80, capitalPct: 8, riskPercent: 1.2 } });
  const paper = await resolve(paperFixture.policy, { effectivePaperMode: true });
  assert.equal(live.actualAmount, 80);
  assert.equal(paper.actualAmount, 80);

  const skipFixture = buildPolicy({
    sizing: { skip: true, size: 0, reason: '포지션 크기 0 < 최소 10', capitalPct: null, riskPercent: null },
  });
  const skipPersist = [];
  const skipPaper = await resolve(skipFixture.policy, {
    effectivePaperMode: true,
    persistCalls: skipPersist,
  });
  assert.equal(skipPaper.success, false);
  assert.equal(skipPersist[0]?.meta?.code, 'position_sizing_rejected');

  const minOrderFixture = buildPolicy({
    sizing: { skip: false, size: 7, capitalPct: 0.7, riskPercent: 1.2 },
    minOrderUsdt: 10,
  });
  const minOrderPersist = [];
  const minOrderPaper = await resolve(minOrderFixture.policy, {
    effectivePaperMode: true,
    persistCalls: minOrderPersist,
  });
  assert.equal(minOrderPaper.success, false);
  assert.equal(minOrderPersist[0]?.meta?.code, 'position_sizing_rejected');

  const previousCap = process.env.LUNA_MAX_TRADE_USDT;
  try {
    process.env.LUNA_MAX_TRADE_USDT = '50';
    const capFixture = buildPolicy({ sizing: { skip: false, size: 120, capitalPct: 12, riskPercent: 1.2 } });
    const cappedPaper = await resolve(capFixture.policy, { effectivePaperMode: true });
    assert.equal(cappedPaper.actualAmount, 50);
    assert.equal(cappedPaper.liveFireCapApplied, true);
  } finally {
    if (previousCap === undefined) delete process.env.LUNA_MAX_TRADE_USDT;
    else process.env.LUNA_MAX_TRADE_USDT = previousCap;
  }

  return {
    ok: true,
    smoke: 'luna-paper-live-sizing',
    scenarios: {
      paperLiveAmountEqual: true,
      paperSizingSkipRejected: true,
      paperMinOrderRejected: true,
      paperLiveFireCapApplied: true,
    },
  };
}

async function main() {
  const result = await runLunaPaperLiveSizingSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna paper/live sizing smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna paper/live sizing smoke 실패:',
  });
}
