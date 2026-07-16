#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  BINANCE_MAJOR_UNIVERSE_BLOCK_REASON,
  BINANCE_TOP_VOLUME_LEGACY_BLOCK_REASON,
  DEFAULT_BINANCE_MAJOR_WHITELIST,
  buildBinanceMajorUniverse,
  buildFixtureBinanceTopVolumeUniverse,
  evaluateBinanceTopVolumeUniverseGate,
  fetchBinanceTopVolumeUniverse,
  parseBinanceMajorWhitelist,
  resolveBinanceUniverseBlockReason,
  resolveCryptoUniverseMode,
} from '../shared/binance-top-volume-universe.ts';
import { runBuySafetyGuards } from '../team/hephaestos/execution-guards.ts';
import { createPaperPromotionPolicy } from '../team/hephaestos/paper-promotion.ts';
import { buildLunaCandidateBottleneckRows } from '../shared/luna-candidate-bottleneck-diagnostics.ts';
import { classifyBacktestBlock } from '../shared/candidate-backtest-gate.ts';
import { NORMAL_ENTRY_TRIGGER_BLOCK_REASONS } from '../shared/luna-expected-fire-watchdog.ts';
import { isExpectedPolicyBlockCode } from '../shared/trade-data-hygiene.ts';

function exchangeInfoFor(symbols = DEFAULT_BINANCE_MAJOR_WHITELIST, overrides = {}) {
  return {
    symbols: symbols.map((canonical) => {
      const base = canonical.split('/')[0];
      return {
        symbol: `${base}USDT`,
        baseAsset: base,
        quoteAsset: 'USDT',
        status: overrides[canonical]?.status || 'TRADING',
        isSpotTradingAllowed: overrides[canonical]?.isSpotTradingAllowed ?? true,
      };
    }).concat([
      { symbol: 'USDCUSDT', baseAsset: 'USDC', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true },
      { symbol: 'PAXGUSDT', baseAsset: 'PAXG', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true },
      { symbol: 'BTCUPUSDT', baseAsset: 'BTCUP', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true },
      { symbol: 'PEPEUSDT', baseAsset: 'PEPE', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true },
    ]),
  };
}

function stableLegacySnapshot() {
  const universe = buildFixtureBinanceTopVolumeUniverse();
  delete universe.fetchedAt;
  return {
    universe,
    inside: evaluateBinanceTopVolumeUniverseGate('BTCUSDT', universe),
    outside: evaluateBinanceTopVolumeUniverseGate('PEPE/USDT', universe),
  };
}

async function verifyExitIsolation(failClosedUniverse) {
  let persisted = 0;
  let persistedBlock = null;
  const sellResult = await runBuySafetyGuards({
    persistFailure: async () => { persisted += 1; },
    symbol: 'PEPE/USDT',
    action: 'SELL',
    signal: { exchange: 'binance' },
    signalTradeMode: 'normal',
    binanceTopVolumeUniverse: failClosedUniverse,
  });
  assert.equal(sellResult, null, 'SELL must bypass the entry universe guard');
  assert.equal(persisted, 0, 'SELL bypass must not persist an entry rejection');

  const buyResult = await runBuySafetyGuards({
    persistFailure: async (_reason, detail) => { persistedBlock = detail; },
    symbol: 'BTC/USDT',
    action: 'BUY',
    signal: { exchange: 'binance' },
    signalTradeMode: 'normal',
    binanceTopVolumeUniverse: failClosedUniverse,
    notifyEnabled: false,
  });
  assert.equal(buyResult.success, false, 'fail-closed universe must reject BUY');
  assert.equal(persistedBlock.code, BINANCE_MAJOR_UNIVERSE_BLOCK_REASON);

  const executorSource = await readFile(new URL('../team/hephaestos/signal-executor.ts', import.meta.url), 'utf8');
  const buyBranch = executorSource.indexOf('if (action === ACTIONS.BUY)');
  const universeGuardCall = executorSource.indexOf('runBuySafetyGuards({');
  assert.ok(buyBranch >= 0 && universeGuardCall > buyBranch, 'universe guard must remain inside BUY branch');

  const stateMachineSource = await readFile(new URL('../shared/pipeline-decision-state-machine.ts', import.meta.url), 'utf8');
  const openPositionsRead = stateMachineSource.indexOf('const openPositions = await db.getOpenPositions');
  const exitDecisionCall = stateMachineSource.indexOf('getExitDecisions(openPositions, exchange)');
  assert.ok(openPositionsRead >= 0 && exitDecisionCall > openPositionsRead, 'EXIT phase must read all open positions independently');
}

export async function runLunaBinanceMajorUniverseSmoke() {
  assert.equal(resolveCryptoUniverseMode({ env: {} }).mode, 'major');
  assert.equal(resolveCryptoUniverseMode({ env: { LUNA_CRYPTO_UNIVERSE_MODE: 'top_volume' } }).mode, 'top_volume');
  assert.equal(resolveCryptoUniverseMode({ env: { LUNA_CRYPTO_UNIVERSE_MODE: 'unexpected' } }).valid, false);

  const defaults = parseBinanceMajorWhitelist({ env: {} });
  assert.equal(defaults.valid, true);
  assert.equal(defaults.symbols.length, 20);
  assert.equal(new Set(defaults.symbols).size, 20);
  const duplicateOverride = parseBinanceMajorWhitelist({
    env: { LUNA_CRYPTO_MAJOR_WHITELIST: Array(20).fill('BTC/USDT').join(',') },
  });
  assert.equal(duplicateOverride.valid, false);
  assert.equal(duplicateOverride.reason, 'major_whitelist_duplicate_symbol');
  assert.equal(parseBinanceMajorWhitelist({ env: { LUNA_CRYPTO_MAJOR_WHITELIST: '' } }).valid, false);

  const major = buildBinanceMajorUniverse({ exchangeInfo: exchangeInfoFor(), whitelistResult: defaults });
  assert.equal(major.available, true);
  assert.equal(major.symbols.length, 20);
  assert.equal(resolveBinanceUniverseBlockReason(major), BINANCE_MAJOR_UNIVERSE_BLOCK_REASON);
  assert.equal(
    resolveBinanceUniverseBlockReason(buildFixtureBinanceTopVolumeUniverse()),
    BINANCE_TOP_VOLUME_LEGACY_BLOCK_REASON,
  );
  assert.equal(evaluateBinanceTopVolumeUniverseGate('BTCUSDT', major).ok, true);
  for (const symbol of ['PEPE/USDT', 'USDC/USDT', 'PAXG/USDT', 'BTCUP/USDT', 'DELISTED/USDT']) {
    const gate = evaluateBinanceTopVolumeUniverseGate(symbol, major);
    assert.equal(gate.blocked, true, `${symbol} must be blocked`);
    assert.equal(gate.reason, BINANCE_MAJOR_UNIVERSE_BLOCK_REASON);
  }
  const promotionPolicy = createPaperPromotionPolicy({
    binanceTopVolumeUniverse: major,
    getCapitalConfig: () => ({
      reserve_ratio: 0.2,
      max_position_pct: 0.1,
      max_concurrent_positions: 3,
    }),
    getDynamicMinOrderAmount: async () => 10,
    fetchTicker: async () => 1,
    getInvestmentTradeMode: () => 'normal',
  });
  const blockedPromotion = await promotionPolicy.simulateBuyDecision({ symbol: 'PEPE/USDT' });
  assert.equal(blockedPromotion.liveReason, BINANCE_MAJOR_UNIVERSE_BLOCK_REASON);
  assert.equal(blockedPromotion.top30Blocker, BINANCE_MAJOR_UNIVERSE_BLOCK_REASON);
  const diagnostic = buildLunaCandidateBottleneckRows([{
    candidate: { symbol: 'PEPE/USDT', market: 'crypto', score: 0.8 },
    binanceTop30Gate: evaluateBinanceTopVolumeUniverseGate('PEPE/USDT', major),
  }])[0];
  assert.ok(diagnostic.reasons.includes(BINANCE_MAJOR_UNIVERSE_BLOCK_REASON));
  assert.equal(diagnostic.top30Blocker, BINANCE_MAJOR_UNIVERSE_BLOCK_REASON);
  assert.equal(isExpectedPolicyBlockCode(BINANCE_MAJOR_UNIVERSE_BLOCK_REASON), true);
  assert.equal(classifyBacktestBlock([BINANCE_MAJOR_UNIVERSE_BLOCK_REASON]).universeBlock, true);
  assert.ok(NORMAL_ENTRY_TRIGGER_BLOCK_REASONS.includes(BINANCE_MAJOR_UNIVERSE_BLOCK_REASON));

  const emptyOverride = buildBinanceMajorUniverse({
    exchangeInfo: exchangeInfoFor(),
    whitelistResult: parseBinanceMajorWhitelist({ env: { LUNA_CRYPTO_MAJOR_WHITELIST: '' } }),
  });
  assert.equal(emptyOverride.available, false);
  assert.equal(emptyOverride.failClosed, true);
  assert.equal(emptyOverride.symbols.length, 0);
  assert.equal(evaluateBinanceTopVolumeUniverseGate('BTC/USDT', emptyOverride).blocked, true);
  const warnings = [];
  const fetchedFailClosed = await fetchBinanceTopVolumeUniverse({
    env: { LUNA_CRYPTO_MAJOR_WHITELIST: '' },
    warnFn: (message) => warnings.push(message),
  });
  assert.equal(fetchedFailClosed.failClosed, true);
  assert.equal(fetchedFailClosed.symbols.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /CRITICAL.*fail-closed/);

  const suspended = buildBinanceMajorUniverse({
    exchangeInfo: exchangeInfoFor(DEFAULT_BINANCE_MAJOR_WHITELIST, { 'BTC/USDT': { status: 'BREAK' } }),
    whitelistResult: defaults,
  });
  assert.equal(suspended.available, false);
  assert.equal(suspended.failClosed, true);
  assert.deepEqual(suspended.invalidSymbols.map((item) => item.symbol), ['BTC/USDT']);
  assert.equal(suspended.symbols.length, 0);
  const spotUnconfirmedInfo = exchangeInfoFor();
  delete spotUnconfirmedInfo.symbols[0].isSpotTradingAllowed;
  const spotUnconfirmed = buildBinanceMajorUniverse({ exchangeInfo: spotUnconfirmedInfo, whitelistResult: defaults });
  assert.equal(spotUnconfirmed.failClosed, true);
  assert.deepEqual(spotUnconfirmed.invalidSymbols[0].reasons, ['spot_trading_not_confirmed']);

  const legacySnapshot = stableLegacySnapshot();
  const legacyHash = createHash('sha256').update(JSON.stringify(legacySnapshot)).digest('hex');
  assert.equal(legacyHash, '4078adfc6d17864386c5bd12d89a7f4ddaa16b384c96386baa400085dcb08cf2');
  assert.equal(legacySnapshot.outside.reason, BINANCE_TOP_VOLUME_LEGACY_BLOCK_REASON);

  await verifyExitIsolation(emptyOverride);
  return {
    ok: true,
    smoke: 'luna-binance-major-universe',
    majorCount: major.symbols.length,
    defaultMode: resolveCryptoUniverseMode({ env: {} }).mode,
    legacyHash,
    boundaries: {
      duplicateAndEmptyFailClosed: true,
      exchangeTradingValidation: true,
      stableGoldLeveragedBlocked: true,
      sellAndExitIsolation: true,
      legacyTopVolumeEquivalent: true,
      rawExchangeInfoFixture: true,
    },
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: runLunaBinanceMajorUniverseSmoke,
    onSuccess: (result) => {
      if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`[luna-binance-major-universe-smoke] ok ${JSON.stringify(result.boundaries)}`);
    },
    errorPrefix: 'luna-binance-major-universe-smoke error:',
  });
}
