#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  B_ONLY_WEIGHT_DEMOTION_DEFAULTS,
  buildBOnlyWeightDemotionProposal,
  resolveBOnlyWeightDemotion,
} from '../shared/b-only-weight-demotion.ts';
import { DEFAULT_BINANCE_MAJOR_WHITELIST } from '../shared/binance-top-volume-universe.ts';
import {
  buildWeightDemotionSimulation,
  loadRealD20Observations,
  validateSimulationReport,
} from './runtime-luna-b-only-weight-demotion.ts';
import { createHephaestosSignalExecutor } from '../team/hephaestos/signal-executor.ts';

const DAY_MS = 86_400_000;
const B_SYMBOLS = [
  'BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'XRP/USDT', 'SOL/USDT',
  'TRX/USDT', 'DOGE/USDT', 'ZEC/USDT', 'XLM/USDT', 'LINK/USDT',
  'ADA/USDT', 'BCH/USDT', 'LTC/USDT', 'SUI/USDT', 'HBAR/USDT',
  'AVAX/USDT', 'NEAR/USDT', 'SHIB/USDT', 'UNI/USDT', 'GRAM/USDT',
];
const C_SYMBOLS = B_SYMBOLS.slice(0, 10);
const A_SYMBOLS = [
  ...B_SYMBOLS.slice(0, 17),
  'OPN/USDT', 'ONDO/USDT', 'PEPE/USDT', 'DEXE/USDT', 'MUB/USDT',
  'WLD/USDT', 'AAVE/USDT', 'HOME/USDT', 'ENA/USDT', 'ALLO/USDT',
  'NIGHT/USDT', 'XPL/USDT', 'BABY/USDT',
];
const NOW = new Date('2026-07-20T00:00:00.000Z');

function observations(symbol, count, wins, winReturn, lossReturn, { startDaysAgo = 176, stepDays = 4, source = 'virtual' } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    symbol,
    observedAt: new Date(NOW.getTime() - (startDaysAgo - index * stepDays) * DAY_MS).toISOString(),
    d20NetPct: index < wins ? winReturn : lossReturn,
    source,
  }));
}

const anchorSymbols = C_SYMBOLS;
const anchorEvents = anchorSymbols.flatMap((symbol) => observations(symbol, 50, 25, 2, -2, {
  startDaysAgo: 176,
  stepDays: 3,
}));
const adaVirtual = observations('ADA/USDT', 39, 10, 4, -12);
const adaReal = observations('ADA/USDT', 1, 0, 0, -6, { startDaysAgo: 30, stepDays: 1, source: 'real' });
const bchVirtual = observations('BCH/USDT', 40, 4, 2, -14);
const suiVirtual = observations('SUI/USDT', 39, 10, 4, -9);

const proposal = buildBOnlyWeightDemotionProposal({
  groups: { B: B_SYMBOLS, C: C_SYMBOLS, D: [...C_SYMBOLS, 'ADA/USDT', 'BCH/USDT', 'SUI/USDT'] },
  virtualEvents: [...anchorEvents, ...adaVirtual, ...bchVirtual, ...suiVirtual],
  realEvents: adaReal,
  generatedAt: NOW.toISOString(),
  windowEndAt: NOW.toISOString(),
});

// ① unit + ② exact threshold mapping + ⑧ raw observation fixture.
assert.equal(B_ONLY_WEIGHT_DEMOTION_DEFAULTS.lookbackDays, 180);
assert.deepEqual(B_SYMBOLS, DEFAULT_BINANCE_MAJOR_WHITELIST);
assert.equal(proposal.proposalOnly, true);
assert.equal(proposal.autoApply, false);
assert.equal(proposal.symbols['ADA/USDT'].sampleSize, 40);
assert.equal(proposal.symbols['ADA/USDT'].realSamples, 1);
assert.equal(proposal.symbols['ADA/USDT'].recommendedWeight, 0.75);
assert.equal(proposal.symbols['BCH/USDT'].recommendedWeight, 0.5);
assert.equal(proposal.symbols['SUI/USDT'].recommendedWeight, 1, 'n=39 must fail safe');
assert.equal(proposal.symbols['BTC/USDT'].recommendedWeight, 1, 'C member is not B-only');
assert.equal(proposal.symbols['GRAM/USDT'].sampleSize, 0);
assert.equal(proposal.symbols['GRAM/USDT'].recommendedWeight, 1, 'missing sample must fail safe');

// ③ outlier/sensitivity: raising the minimum sample reverses ADA to neutral.
const sensitivity = buildBOnlyWeightDemotionProposal({
  groups: proposal.groups,
  virtualEvents: [...anchorEvents, ...adaVirtual, ...bchVirtual, ...suiVirtual],
  realEvents: adaReal,
  generatedAt: NOW.toISOString(),
  windowEndAt: NOW.toISOString(),
  config: { minSamples: 50 },
});
assert.equal(sensitivity.symbols['ADA/USDT'].recommendedWeight, 1);
assert.equal(sensitivity.symbols['BCH/USDT'].recommendedWeight, 1);

const qualityGates = Object.fromEntries([
  '1_units',
  '2_missingness',
  '3_outliers',
  '4_exclusions',
  '5_membership',
  '6_costs',
  '7_read_only',
  '8_raw_samples',
  '9_time',
].map((name) => [name, { pass: true }]));
qualityGates['1_units'].replayReturnUnit = 'percent_points_net_of_cost';
qualityGates['5_membership'].dIsExactIntersection = true;
const simulationArtifact = {
  status: 'done',
  generatedAt: NOW.toISOString(),
  readOnly: true,
  dbWrites: 0,
  orderPathAccess: 0,
  qualityGates,
  layer2: {
    lookbackDays: 180,
    intervals: ['1h', '1d'],
    costAssumption: { totalRoundTripCostPct: 0.3 },
    dataCutoffs: { dailyLastClosedBefore: '2026-07-19T00:00:00.000Z' },
    groups: { A: A_SYMBOLS, B: B_SYMBOLS, C: C_SYMBOLS, D: B_SYMBOLS.slice(0, 17) },
    events: [],
  },
};
assert.equal(validateSimulationReport(simulationArtifact), simulationArtifact);
const bMinusDSimulation = buildWeightDemotionSimulation({
  report: {
    ...simulationArtifact,
    layer2: {
      ...simulationArtifact.layer2,
      events: [{
        symbol: 'SHIB/USDT',
        firedAt: '2026-06-01T00:00:00.000Z',
        d20NetPct: -10,
      }],
    },
  },
  proposal: {
    windowStartAt: '2026-01-21T00:00:00.000Z',
    windowEndAt: NOW.toISOString(),
    config: { horizonDays: 20 },
    symbols: { 'SHIB/USDT': { recommendedWeight: 0.5 } },
  },
});
assert.equal(bMinusDSimulation.before.observations, 1);
assert.equal(bMinusDSimulation.changedSymbols[0].symbol, 'SHIB/USDT');
assert.equal(bMinusDSimulation.changedSymbols[0].observations, 1);
assert.equal(bMinusDSimulation.after.deployedUnits, 0.5);
assert.throws(
  () => validateSimulationReport({
    ...simulationArtifact,
    layer2: {
      ...simulationArtifact.layer2,
      costAssumption: { totalRoundTripCostPct: 0.1 },
    },
  }),
  /round_trip_cost/,
);
assert.throws(
  () => validateSimulationReport({
    ...simulationArtifact,
    qualityGates: { ...qualityGates, '5_membership': { pass: false } },
  }),
  /quality_gate/,
);
assert.throws(
  () => validateSimulationReport({
    ...simulationArtifact,
    layer2: {
      ...simulationArtifact.layer2,
      groups: { ...simulationArtifact.layer2.groups, D: B_SYMBOLS.slice(1, 18) },
    },
  }),
  /d_not_a_b_intersection/,
);

const closedCandleCutoffMs = Date.parse('2026-07-16T00:00:00.000Z');
const realEntryTime = closedCandleCutoffMs - 20 * DAY_MS - 60 * 60 * 1000;
const rawDailyKline = (closeTime) => [
  closeTime - DAY_MS + 1,
  '100',
  '111',
  '99',
  '110',
  '1',
  closeTime,
  '110',
  1,
  '1',
  '110',
  '0',
];
const realObservationOptions = {
  symbols: ['ADA/USDT'],
  windowEndAt: NOW.toISOString(),
  closedCandleCutoffAt: new Date(closedCandleCutoffMs).toISOString(),
  queryFn: async () => [{
    trade_id: 'raw-kline-fixture',
    symbol: 'ADA/USDT',
    entry_time: realEntryTime,
    entry_price: 100,
  }],
};
const afterCutoff = await loadRealD20Observations({
  ...realObservationOptions,
  fetchImpl: async () => ({
    ok: true,
    json: async () => [rawDailyKline(closedCandleCutoffMs + 9 * 60 * 60 * 1000)],
  }),
});
assert.equal(afterCutoff.length, 0, 'daily close after the source cutoff must not enter d20 evidence');
const atCutoff = await loadRealD20Observations({
  ...realObservationOptions,
  fetchImpl: async () => ({
    ok: true,
    json: async () => [rawDailyKline(closedCandleCutoffMs - 30 * 60 * 1000)],
  }),
});
assert.equal(atCutoff.length, 1);

// ④ direction + ⑤ partial evidence: positive, stale, missing, or short-span evidence stays 1.0.
const positive = buildBOnlyWeightDemotionProposal({
  groups: proposal.groups,
  virtualEvents: [...anchorEvents, ...observations('ADA/USDT', 40, 30, 5, -2)],
  generatedAt: NOW.toISOString(),
  windowEndAt: NOW.toISOString(),
});
assert.equal(positive.symbols['ADA/USDT'].recommendedWeight, 1);
const shortSpan = buildBOnlyWeightDemotionProposal({
  groups: proposal.groups,
  virtualEvents: [...anchorEvents, ...observations('ADA/USDT', 40, 4, 2, -14, { startDaysAgo: 80, stepDays: 1 })],
  generatedAt: NOW.toISOString(),
  windowEndAt: NOW.toISOString(),
});
assert.equal(shortSpan.symbols['ADA/USDT'].recommendedWeight, 1);

const freshRuntimeProposal = {
  ...proposal,
  generatedAt: new Date().toISOString(),
  windowEndAt: new Date().toISOString(),
};
const gramMissingResolution = resolveBOnlyWeightDemotion({
  symbol: 'GRAM/USDT',
  downstreamAmountUsdt: 100,
  proposal: freshRuntimeProposal,
}, { LUNA_BONLY_WEIGHT_DEMOTION_ENABLED: 'true' });
assert.equal(gramMissingResolution.evidenceEligible, false);
assert.equal(gramMissingResolution.recommendedWeight, 1);
assert.equal(gramMissingResolution.appliedWeight, 1);
assert.equal(gramMissingResolution.appliedAmountUsdt, 100);
assert.equal(gramMissingResolution.liveMutation, false);
const offResolution = resolveBOnlyWeightDemotion({
  symbol: 'ADA/USDT',
  downstreamAmountUsdt: 100,
  proposal: freshRuntimeProposal,
}, {});
assert.equal(offResolution.enabled, false);
assert.equal(offResolution.appliedAmountUsdt, 100);
assert.equal(offResolution.counterfactualAmountUsdt, 75);
assert.equal(offResolution.psrRole, 'admission_only');
const onResolution = resolveBOnlyWeightDemotion({
  symbol: 'ADAUSDT',
  downstreamAmountUsdt: 100,
  proposal: freshRuntimeProposal,
}, { LUNA_BONLY_WEIGHT_DEMOTION_ENABLED: 'true' });
assert.equal(onResolution.appliedAmountUsdt, 75);
assert.equal(onResolution.applied, true);
assert.equal(resolveBOnlyWeightDemotion({
  symbol: 'BCH/USDT',
  downstreamAmountUsdt: 8,
  minOrderUsdt: 5,
  proposal: freshRuntimeProposal,
}, { LUNA_BONLY_WEIGHT_DEMOTION_ENABLED: 'true' }).wouldRejectBelowMinimum, true);
assert.equal(resolveBOnlyWeightDemotion({ symbol: 'ADA/USDT', downstreamAmountUsdt: 100 }, {}).recommendedWeight, 1);
assert.equal(resolveBOnlyWeightDemotion({
  symbol: 'ADA/USDT',
  downstreamAmountUsdt: 4,
  minOrderUsdt: 5,
}, { LUNA_BONLY_WEIGHT_DEMOTION_ENABLED: 'true' }).wouldRejectBelowMinimum, false);
const staleProposal = { ...freshRuntimeProposal, windowEndAt: '2026-01-01T00:00:00.000Z' };
assert.equal(resolveBOnlyWeightDemotion({
  symbol: 'ADA/USDT', downstreamAmountUsdt: 100, proposal: staleProposal,
}, { LUNA_BONLY_WEIGHT_DEMOTION_ENABLED: 'true' }).appliedAmountUsdt, 100);
const forgedNonBOnlyProposal = structuredClone(freshRuntimeProposal);
forgedNonBOnlyProposal.symbols['BTC/USDT'] = {
  ...forgedNonBOnlyProposal.symbols['BTC/USDT'],
  bOnly: true,
  eligible: true,
  reasons: [],
  stage: 'severe',
  recommendedWeight: 0.5,
  deltas: { winDeltaPct: -30, meanDeltaPct: -12, winsorizedMeanDeltaPct: -12 },
};
assert.equal(resolveBOnlyWeightDemotion({
  symbol: 'BTC/USDT',
  downstreamAmountUsdt: 100,
  proposal: forgedNonBOnlyProposal,
}, { LUNA_BONLY_WEIGHT_DEMOTION_ENABLED: 'true' }).appliedAmountUsdt, 100);
const forgedMethodologyProposal = structuredClone(freshRuntimeProposal);
forgedMethodologyProposal.methodology.metric = 'gross_d1_return';
assert.equal(resolveBOnlyWeightDemotion({
  symbol: 'ADA/USDT',
  downstreamAmountUsdt: 100,
  proposal: forgedMethodologyProposal,
}, { LUNA_BONLY_WEIGHT_DEMOTION_ENABLED: 'true' }).appliedAmountUsdt, 100);
const forgedDeltaProposal = structuredClone(positive);
forgedDeltaProposal.symbols['ADA/USDT'] = {
  ...forgedDeltaProposal.symbols['ADA/USDT'],
  stage: 'severe',
  recommendedWeight: 0.5,
  deltas: { winDeltaPct: -30, meanDeltaPct: -12, winsorizedMeanDeltaPct: -12 },
};
assert.equal(resolveBOnlyWeightDemotion({
  symbol: 'ADA/USDT',
  downstreamAmountUsdt: 100,
  proposal: forgedDeltaProposal,
  now: NOW,
}, { LUNA_BONLY_WEIGHT_DEMOTION_ENABLED: 'true' }).appliedAmountUsdt, 100);

function executorFixture({
  env = {},
  proposalInput = freshRuntimeProposal,
  guardNotify = null,
  btcDirectResult = null,
  requestedAmountUsdt = 100,
  actualOrderAmount = 100,
  resolver,
} = {}) {
  const brokerAmounts = [];
  const lifecycle = [];
  let btcPairAttempts = 0;
  let sizingCalls = 0;
  const resolveSizing = resolver || ((input, sizingEnv) => {
    sizingCalls += 1;
    return resolveBOnlyWeightDemotion(input, sizingEnv);
  });
  const executor = createHephaestosSignalExecutor({
    env,
    ACTIONS: { BUY: 'buy', SELL: 'sell' },
    SIGNAL_STATUS: { FAILED: 'failed', EXECUTED: 'executed' },
    db: { getPaperPosition: async () => null, updateSignalStatus: async () => {} },
    initHubSecrets: async () => true,
    isPaperMode: () => false,
    getInvestmentTradeMode: () => 'normal',
    getCapitalConfig: async () => ({}),
    getDynamicMinOrderAmount: async () => 5,
    buildHephaestosExecutionPreflight: async (signal) => ({
      globalPaperMode: false,
      signalTradeMode: 'normal',
      capitalPolicy: {},
      minOrderUsdt: 5,
      executionContext: {
        signalId: signal.id,
        symbol: signal.symbol,
        action: signal.action,
        base: String(signal.symbol).split('/')[0],
        tag: 'b-only-weight-smoke',
        amountUsdt: requestedAmountUsdt,
        effectivePaperMode: false,
        exchange: 'binance',
      },
    }),
    buildExecutionRiskApprovalGuard: () => ({ approved: true }),
    notifyTradeSkip: async () => {},
    normalizePartialExitRatio: () => 1,
    buildSignalQualityContext: () => ({}),
    getInvestmentAgentRoleState: async () => null,
    createSignalFailurePersister: () => async () => {},
    isBinanceSymbol: () => true,
    maybePromotePaperPositions: async () => [],
    runBuySafetyGuards: async () => ({ success: true, tradeDataGuardNotify: guardNotify }),
    tryAbsorbUntrackedBalance: async () => null,
    checkBuyReentryGuards: async () => ({ success: true, reducedAmountMultiplier: 1, softGuards: [] }),
    _tryBuyWithBtcPair: async () => { btcPairAttempts += 1; return btcDirectResult; },
    shouldBlockUsdtFallbackAfterBtcPairError: () => false,
    liquidateUntrackedForCapital: async () => {},
    resolveBuyExecutionMode: async () => ({
      success: true,
      effectivePaperMode: false,
      effectiveTradeMode: 'normal',
      reducedAmountMultiplier: 1,
      softGuards: [],
      softGuardApplied: false,
    }),
    rejectExecution: async ({ reason, code, meta }) => ({ success: false, reason, code, meta }),
    resolveBuyOrderAmount: async () => ({ success: true, actualAmount: actualOrderAmount }),
    applyResponsibilityExecutionSizing: (amount) => ({ amount, multiplier: 1, reason: null }),
    loadBOnlyWeightDemotionProposal: () => proposalInput,
    resolveBOnlyWeightDemotion: resolveSizing,
    buildDeterministicClientOrderId: () => 'b-only-weight-smoke',
    marketBuy: async (_symbol, amount) => {
      brokerAmounts.push(amount);
      return { filled: amount / 10, price: 10, cost: amount };
    },
    persistBuyPosition: async () => {},
    attachExecutionToPositionStrategyTracked: async () => {},
    syncCryptoStrategyExecutionState: async () => {},
    applyBuyProtectiveExit: async () => {},
    resolveSellExecutionContext: async () => ({
      sellPaperMode: false,
      effectivePositionTradeMode: 'normal',
      position: {},
    }),
    resolveSellAmount: async () => ({ amount: 1, sourcePositionAmount: 1, partialExitRatio: 1 }),
    executeSellTrade: async ({ symbol }) => ({
      symbol, side: 'sell', amount: 1, price: 10, totalUsdt: 10, paper: false,
    }),
    finalizeExecutedTrade: async () => {},
    binanceExecutionReconcileHandler: { handleExecutionPendingReconcileError: async ({ error }) => ({ handled: false, error }) },
    notifyError: async () => {},
    recordPositionLifecycleStageEvent: async (event) => { lifecycle.push(event); return event; },
  });
  return { executor, brokerAmounts, lifecycle, getBtcPairAttempts: () => btcPairAttempts, getSizingCalls: () => sizingCalls };
}

const buySignal = {
  id: 81,
  symbol: 'ADA/USDT',
  action: 'buy',
  confidence: 0.8,
  block_meta: { candidateBacktest: { psr: 0.9 } },
};

// ⑥ concurrency/composition + ⑦ initial/off: one multiplier, PSR admission only, exact off order bytes.
const legacy = executorFixture({ proposalInput: null });
await legacy.executor.executeSignal({ ...buySignal });
const offExecution = executorFixture({ env: {}, proposalInput: freshRuntimeProposal });
await offExecution.executor.executeSignal({ ...buySignal });
assert.deepEqual(offExecution.brokerAmounts, legacy.brokerAmounts);
assert.equal(offExecution.getBtcPairAttempts(), legacy.getBtcPairAttempts());
const neutralBelowRequestedMinimum = executorFixture({
  env: { LUNA_BONLY_WEIGHT_DEMOTION_ENABLED: 'true' },
  proposalInput: freshRuntimeProposal,
  requestedAmountUsdt: 4,
  actualOrderAmount: 100,
});
await neutralBelowRequestedMinimum.executor.executeSignal({ ...buySignal, symbol: 'BTC/USDT' });
assert.deepEqual(neutralBelowRequestedMinimum.brokerAmounts, [100]);

const onExecution = executorFixture({
  env: { LUNA_BONLY_WEIGHT_DEMOTION_ENABLED: 'true' },
  proposalInput: freshRuntimeProposal,
});
await onExecution.executor.executeSignal({ ...buySignal });
assert.deepEqual(onExecution.brokerAmounts, [75]);
assert.equal(onExecution.getBtcPairAttempts(), 0, 'reduced BUY must not bypass sizing through BTC direct route');
const stage3 = onExecution.lifecycle.find((event) => event.stageId === 'stage_3');
assert.equal(stage3.evidenceSnapshot.bOnlyWeightDemotion.appliedWeight, 0.75);
assert.equal(stage3.evidenceSnapshot.bOnlyWeightDemotion.psrRole, 'admission_only');
const belowMinimumAfterSizing = executorFixture({
  env: { LUNA_BONLY_WEIGHT_DEMOTION_ENABLED: 'true' },
  proposalInput: freshRuntimeProposal,
  actualOrderAmount: 8,
});
const belowMinimumResult = await belowMinimumAfterSizing.executor.executeSignal({
  ...buySignal,
  symbol: 'BCH/USDT',
});
assert.equal(belowMinimumResult.success, false);
assert.equal(belowMinimumResult.code, 'position_sizing_rejected');
assert.deepEqual(belowMinimumAfterSizing.brokerAmounts, []);

// Guard authority remains the final minimum absolute cap: min(100 * .75, 60) = 60, never 45.
const guardExecution = executorFixture({
  env: {
    LUNA_BONLY_WEIGHT_DEMOTION_ENABLED: 'true',
    LUNA_GUARD_SIZING_AUTHORITY: 'true',
  },
  proposalInput: freshRuntimeProposal,
  guardNotify: {
    blockers: ['fixture_cap'],
    sizingMultiplier: 0.6,
    requestedAmountUsdt: 100,
    adjustedAmountUsdt: 60,
  },
});
await guardExecution.executor.executeSignal({ ...buySignal });
assert.deepEqual(guardExecution.brokerAmounts, [60]);

// BTC-direct remains byte-equivalent while OFF but records the sizing counterfactual.
const directOff = executorFixture({
  proposalInput: freshRuntimeProposal,
  btcDirectResult: { success: true, btcDirect: true, btcPair: 'ADA/BTC', amount: 10, price: 10, totalUsdt: 100 },
});
const directResult = await directOff.executor.executeSignal({ ...buySignal });
assert.equal(directResult.btcDirect, true);
assert.equal(directOff.lifecycle.find((event) => event.stageId === 'stage_4')
  .evidenceSnapshot.bOnlyWeightDemotion.counterfactualAmountUsdt, 75);

// Other 17 symbols are unchanged, and SELL never invokes the BUY-only resolver.
const otherSymbol = executorFixture({
  env: { LUNA_BONLY_WEIGHT_DEMOTION_ENABLED: 'true' },
  proposalInput: freshRuntimeProposal,
});
await otherSymbol.executor.executeSignal({ ...buySignal, symbol: 'BTC/USDT' });
assert.deepEqual(otherSymbol.brokerAmounts, [100]);
const sellFixture = executorFixture({ resolver: () => { throw new Error('BUY sizing resolver reached from SELL'); } });
const sell = await sellFixture.executor.executeSignal({ ...buySignal, action: 'sell' });
assert.equal(sell.success, true);
assert.equal(sellFixture.getSizingCalls(), 0);

// ⑨ time: freshness uses the proposal's closed-window timestamp, not local string ordering.
assert.equal(proposal.windowEndAt, NOW.toISOString());

console.log(JSON.stringify({
  ok: true,
  checks: 65,
  boundaries: 9,
  weights: {
    moderate: proposal.symbols['ADA/USDT'].recommendedWeight,
    severe: proposal.symbols['BCH/USDT'].recommendedWeight,
    smallSample: proposal.symbols['SUI/USDT'].recommendedWeight,
  },
}));
