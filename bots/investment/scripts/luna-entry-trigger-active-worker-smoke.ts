#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import * as db from '../shared/db.ts';
import { insertEntryTrigger } from '../shared/luna-discovery-entry-store.ts';
import {
  evaluateActiveEntryTriggerQualityGate,
  evaluateActiveEntryTriggersAgainstMarketEvents,
  loadActiveEntryTriggerQuality,
  refreshEntryTriggersFromRecentBuySignals,
} from '../shared/entry-trigger-engine.ts';
import {
  buildEntryTriggerWorkerRiskContext,
  deriveMarketEvents,
  materializeFiredEntryTriggerSignals,
} from './luna-entry-trigger-worker.ts';

function bullishCandles(length = 30, start = 100) {
  return Array.from({ length }, (_, index) => {
    const open = start + index * 0.12;
    const close = open + 0.08;
    return [Date.now() - (length - index) * 60_000, open, close + 0.04, open - 0.04, close, 1000 + index];
  });
}

function withEnv(patch = {}, fn) {
  const prev = {};
  for (const key of Object.keys(patch)) {
    prev[key] = process.env[key];
    process.env[key] = patch[key];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const key of Object.keys(patch)) {
        if (prev[key] == null) delete process.env[key];
        else process.env[key] = prev[key];
      }
    });
}

function makeSmokeTop30Universe(symbols = []) {
  const canonical = [...new Set(symbols)];
  return {
    source: 'smoke_binance_top30_universe',
    fetchedAt: new Date().toISOString(),
    limit: 30,
    symbols: canonical,
    ranks: Object.fromEntries(canonical.map((symbol, index) => [symbol, index + 1])),
  };
}

export async function runLunaEntryTriggerActiveWorkerSmoke() {
  return withEnv({
    LUNA_ENTRY_TRIGGER_ENGINE_ENABLED: 'true',
    LUNA_INTELLIGENT_DISCOVERY_MODE: 'autonomous_l5',
    LUNA_LIVE_FIRE_ENABLED: 'true',
    LUNA_ENTRY_TRIGGER_FIRE_IN_AUTONOMOUS: 'true',
    LUNA_ENTRY_TRIGGER_ACTIVE_QUALITY_GATE_ENABLED: 'false',
    LUNA_MAX_TRADE_USDT: '50',
  }, async () => {
    const symbol = `ACTIVE${Date.now().toString(36).toUpperCase()}/USDT`;
    const pullbackSymbol = `PULLBACK${Date.now().toString(36).toUpperCase()}/USDT`;
    const refreshSymbol = `REFRESH${Date.now().toString(36).toUpperCase()}/USDT`;
    const openSymbol = `OPENPOS${Date.now().toString(36).toUpperCase()}/USDT`;
    const mtfRefreshSymbol = `MTFREFRESH${Date.now().toString(36).toUpperCase()}/USDT`;
    const kisMtfRefreshSymbol = `KISMTF${Date.now().toString(36).toUpperCase()}`;
    const bearishMtfSymbol = `BEARMTF${Date.now().toString(36).toUpperCase()}/USDT`;
    const weakPullbackSymbol = `WEAKPULL${Date.now().toString(36).toUpperCase()}/USDT`;
    const technicalProbePullbackSymbol = `TECHPULL${Date.now().toString(36).toUpperCase()}/USDT`;
    const dryRunFireSymbol = `DRYRUNFIRE${Date.now().toString(36).toUpperCase()}/USDT`;
    const missingEventSymbol = `MISSVEVENT${Date.now().toString(36).toUpperCase()}/USDT`;
    const terminalLowConfSymbol = `TERMINALCONF${Date.now().toString(36).toUpperCase()}/USDT`;
    const qualityBlockedSymbol = `QUALITYBLOCK${Date.now().toString(36).toUpperCase()}/USDT`;
    const qualityHardGateSymbol = `QUALITYHARD${Date.now().toString(36).toUpperCase()}/USDT`;
    const qualityPredictiveFallbackSymbol = `QUALITYPRED${Date.now().toString(36).toUpperCase()}/USDT`;
    const trendingBullNoMtfSymbol = `TRENDNOMTF${Date.now().toString(36).toUpperCase()}/USDT`;
    const binanceTopVolumeUniverse = makeSmokeTop30Universe([
      symbol,
      pullbackSymbol,
      refreshSymbol,
      openSymbol,
      mtfRefreshSymbol,
      bearishMtfSymbol,
      weakPullbackSymbol,
      technicalProbePullbackSymbol,
      dryRunFireSymbol,
      missingEventSymbol,
      terminalLowConfSymbol,
      qualityBlockedSymbol,
      qualityHardGateSymbol,
      qualityPredictiveFallbackSymbol,
      trendingBullNoMtfSymbol,
      'FAKE/USDT',
      'RLUSD/USDT',
    ]);
    let signalId = null;
    let openSignalId = null;
    let smokeOriginSignalId = null;
    try {
      signalId = await db.insertSignal({
        symbol: refreshSymbol,
        action: 'BUY',
        amountUsdt: 50,
        confidence: 0.82,
        reasoning: 'refresh signal continuity test',
        status: 'approved',
        exchange: 'binance',
        strategyFamily: 'breakout',
      });
      await db.run(
        `UPDATE signals SET block_meta = $1::jsonb WHERE id = $2`,
        [JSON.stringify({ atr: 2, entry_price: 100, tp_sl_set: true }), signalId],
      );
      const refresh = await refreshEntryTriggersFromRecentBuySignals({ exchange: 'binance', hours: 1, limit: 5 });
      assert.ok(refresh.sourceSignals >= 1, 'recent BUY signal should be considered for entry-trigger refresh');
      assert.ok(refresh.armed >= 1 || refresh.observed >= 1, 'recent BUY signal should arm or observe an entry trigger');

      smokeOriginSignalId = await db.insertSignal({
        symbol: `SMOKEORIGIN${Date.now().toString(36).toUpperCase()}/USDT`,
        action: 'BUY',
        amountUsdt: 50,
        confidence: 0.99,
        reasoning: 'execution_origin smoke must not enter entry-trigger refresh',
        status: 'approved',
        exchange: 'binance',
        executionOrigin: 'smoke',
        qualityFlag: 'trusted',
        excludeFromLearning: false,
        strategyFamily: 'breakout',
      });
      const smokeOriginRefresh = await refreshEntryTriggersFromRecentBuySignals({ exchange: 'binance', hours: 1, limit: 10 });
      assert.equal(
        smokeOriginRefresh.sourceSignals,
        refresh.sourceSignals,
        'execution_origin=smoke BUY signal must be excluded from entry-trigger refresh source signals',
      );

      openSignalId = await db.insertSignal({
        symbol: openSymbol,
        action: 'BUY',
        amountUsdt: 50,
        confidence: 0.9,
        reasoning: 'open position entry trigger should not be refreshed',
        status: 'approved',
        exchange: 'binance',
        strategyFamily: 'breakout',
      });
      await db.run(
        `UPDATE signals SET block_meta = $1::jsonb WHERE id = $2`,
        [JSON.stringify({ atr: 2, entry_price: 100, tp_sl_set: true }), openSignalId],
      );
      const openRefresh = await refreshEntryTriggersFromRecentBuySignals({
        exchange: 'binance',
        hours: 1,
        limit: 10,
        context: { openPositionSymbols: [openSymbol] },
      });
      assert.ok(openRefresh.sourceSignals >= 1, 'open position BUY signal should still be inspected');
      const openRows = await db.query(
        `SELECT * FROM entry_triggers WHERE symbol = $1 AND trigger_state IN ('armed', 'waiting')`,
        [openSymbol],
      );
      assert.equal(openRows.length, 0, 'open position symbol must not keep active entry triggers');

      const trigger = await insertEntryTrigger({
        symbol,
        exchange: 'binance',
        setupType: 'breakout_confirmation',
        triggerType: 'breakout_confirmation',
        triggerState: 'armed',
        confidence: 0.78,
        waitingFor: 'breakout_confirmation',
        triggerContext: {
          hints: { mtfAgreement: 0.7, discoveryScore: 0.7 },
        },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      assert.ok(trigger?.id);

      const capitalSnapshot = {
        mode: 'ACTIVE_DISCOVERY',
        balanceStatus: 'ok',
        buyableAmount: 500,
        minOrderAmount: 10,
        remainingSlots: 2,
      };

      const result = await evaluateActiveEntryTriggersAgainstMarketEvents([
        {
          symbol,
          mtfAgreement: 0.82,
          discoveryScore: 0.79,
          breakoutRetest: true,
          volumeBurst: 2.0,
          tradingViewSnapshot: {
            ok: true,
            source: 'tradingview_ws_service',
            providerMode: 'websocket',
            market: 'tradingview',
            price: 101,
            open: 100,
            stale: false,
          },
        },
      ], {
        exchange: 'binance',
        env: { ...process.env, LUNA_FULL_DATA_LOOP_ENABLED: 'false' },
        capitalSnapshot,
        binanceTopVolumeUniverse,
      });
      assert.equal(result.enabled, true);
      assert.equal(result.checked, 1);
      assert.equal(result.fired, 1);
      assert.equal(result.results[0].fired, true);

      const row = await db.get(`SELECT trigger_state FROM entry_triggers WHERE id = $1`, [trigger.id]);
      assert.equal(row?.trigger_state, 'fired');

      const pullbackTrigger = await insertEntryTrigger({
        symbol: pullbackSymbol,
        exchange: 'binance',
        setupType: 'mean_reversion',
        triggerType: 'pullback_to_support',
        triggerState: 'armed',
        confidence: 0.73,
        predictiveScore: 0.63,
        targetPrice: 101,
        waitingFor: 'pullback_to_support',
        triggerContext: {
          hints: { mtfAgreement: 0, discoveryScore: 0.62, volumeBurst: 0.55, breakoutRetest: false },
        },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      assert.ok(pullbackTrigger?.id);
      const pullbackResult = await evaluateActiveEntryTriggersAgainstMarketEvents([
        {
          symbol: pullbackSymbol,
          price: 101,
          targetPrice: 101,
          mtfAgreement: 0,
          discoveryScore: 0.62,
          volumeBurst: 0.55,
          breakoutRetest: true,
          tradingViewSnapshot: {
            ok: true,
            source: 'tradingview_ws_service',
            providerMode: 'websocket',
            market: 'tradingview',
            price: 101,
            open: 100,
            stale: false,
          },
        },
      ], {
        exchange: 'binance',
        capitalSnapshot,
        binanceTopVolumeUniverse,
      });
      assert.equal(pullbackResult.checked, 1);
      assert.equal(pullbackResult.fired, 1);
      assert.equal(pullbackResult.results[0].fired, true);

      const weakPullbackTrigger = await insertEntryTrigger({
        symbol: weakPullbackSymbol,
        exchange: 'binance',
        setupType: 'mean_reversion',
        triggerType: 'pullback_to_support',
        triggerState: 'armed',
        confidence: 0.59,
        predictiveScore: 0.51,
        targetPrice: 101,
        waitingFor: 'pullback_to_support',
        triggerContext: {
          hints: { mtfAgreement: 0.9, discoveryScore: 0.62, breakoutRetest: true },
        },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      assert.ok(weakPullbackTrigger?.id);
      const weakPullbackResult = await evaluateActiveEntryTriggersAgainstMarketEvents([
        {
          symbol: weakPullbackSymbol,
          mtfAgreement: 0.9,
          mtfAlignmentScore: 0.8,
          mtfDominantSignal: 'BUY',
          discoveryScore: 0.62,
          breakoutRetest: true,
        },
      ], {
        exchange: 'binance',
        capitalSnapshot,
        binanceTopVolumeUniverse,
      });
      assert.equal(weakPullbackResult.results[0].fired, false, 'pullback trigger must not bypass predictive/confidence checks through generic MTF rules');
      assert.equal(weakPullbackResult.results[0].fireReason, 'pullback_confirmation_incomplete');

      const technicalProbePullbackTrigger = await insertEntryTrigger({
        symbol: technicalProbePullbackSymbol,
        exchange: 'binance',
        setupType: 'mean_reversion',
        triggerType: 'pullback_to_support',
        triggerState: 'armed',
        confidence: 0.5962,
        predictiveScore: 0.5182,
        targetPrice: 101,
        waitingFor: 'pullback_to_support',
        triggerContext: {
          hints: { mtfAgreement: 0.2, discoveryScore: 0.5331, volumeBurst: 1.2105, breakoutRetest: false },
        },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      assert.ok(technicalProbePullbackTrigger?.id);
      const technicalProbePullbackResult = await evaluateActiveEntryTriggersAgainstMarketEvents([
        {
          symbol: technicalProbePullbackSymbol,
          mtfAgreement: 1,
          mtfAlignmentScore: 0.246,
          mtfDominantSignal: 'BUY',
          discoveryScore: 0.5331,
          volumeBurst: 1.2105,
          breakoutRetest: true,
          tradingViewSnapshot: {
            ok: true,
            source: 'tradingview_ws_service',
            providerMode: 'websocket',
            market: 'tradingview',
            price: 101,
            open: 100,
            stale: false,
          },
        },
      ], {
        exchange: 'binance',
        capitalSnapshot,
        binanceTopVolumeUniverse,
      });
      assert.equal(technicalProbePullbackResult.results[0].fired, true, 'near-threshold pullback with fresh MTF/retest/volume confirmation should fire as a bounded technical probe');
      const technicalProbeRow = await db.get(`SELECT trigger_meta FROM entry_triggers WHERE id = $1`, [technicalProbePullbackTrigger.id]);
      assert.equal(technicalProbeRow?.trigger_meta?.fireReadiness?.technicalProbeApplied, true);
      assert.equal(technicalProbeRow?.trigger_meta?.fireReadiness?.technicalConfirmation?.ok, true);

      const openTrigger = await insertEntryTrigger({
        symbol: openSymbol,
        exchange: 'binance',
        setupType: 'breakout_confirmation',
        triggerType: 'breakout_confirmation',
        triggerState: 'armed',
        confidence: 0.8,
        waitingFor: 'breakout_confirmation',
        triggerContext: {
          hints: { mtfAgreement: 0.8, discoveryScore: 0.8 },
        },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      assert.ok(openTrigger?.id);
      const openEventResult = await evaluateActiveEntryTriggersAgainstMarketEvents([
        {
          symbol: openSymbol,
          mtfAgreement: 0.85,
          discoveryScore: 0.8,
          breakoutRetest: true,
        },
      ], {
        exchange: 'binance',
        openPositionSymbols: [openSymbol],
        binanceTopVolumeUniverse,
      });
      assert.equal(openEventResult.checked, 0, 'open position trigger should be expired before event evaluation');
      const expiredOpenTrigger = await db.get(`SELECT trigger_state FROM entry_triggers WHERE id = $1`, [openTrigger.id]);
      assert.equal(expiredOpenTrigger?.trigger_state, 'expired');

      const staleReasonSymbol = `STALEBLOCK${Date.now().toString(36).toUpperCase()}/USDT`;
      binanceTopVolumeUniverse.symbols.push(staleReasonSymbol);
      binanceTopVolumeUniverse.ranks[staleReasonSymbol] = binanceTopVolumeUniverse.symbols.length;
      const staleReasonTrigger = await insertEntryTrigger({
        symbol: staleReasonSymbol,
        exchange: 'binance',
        setupType: 'mean_reversion',
        triggerType: 'pullback_to_support',
        triggerState: 'waiting',
        confidence: 0.51,
        predictiveScore: 0.41,
        targetPrice: 100,
        waitingFor: 'pullback_to_support',
        triggerContext: {
          hints: { mtfAgreement: 0, discoveryScore: 0.45, volumeBurst: 0.4, breakoutRetest: false },
        },
        triggerMeta: {
          reason: 'live_risk_gate_blocked',
          riskGateReason: 'capital_check_not_accepted',
        },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      const staleReasonResult = await evaluateActiveEntryTriggersAgainstMarketEvents([
        {
          symbol: staleReasonSymbol,
          price: 99,
          targetPrice: 100,
          mtfAgreement: 0,
          discoveryScore: 0.45,
          volumeBurst: 0.4,
          breakoutRetest: false,
        },
      ], {
        exchange: 'binance',
        binanceTopVolumeUniverse,
      });
      assert.equal(staleReasonResult.results[0].reason, 'conditions_not_met');
      const staleReasonRow = await db.get(`SELECT trigger_meta FROM entry_triggers WHERE id = $1`, [staleReasonTrigger.id]);
      assert.equal(staleReasonRow?.trigger_meta?.reason, 'conditions_not_met', 'stale blocker reason must be replaced by current readiness state');
      assert.equal(staleReasonRow?.trigger_meta?.riskGateReason, null, 'stale risk gate reason must be cleared when current readiness is conditions_not_met');
      assert.equal(staleReasonRow?.trigger_meta?.terminalBlock, false, 'terminal block flag must be reset when trigger returns to ordinary waiting state');

      const mtfRefreshTrigger = await insertEntryTrigger({
        symbol: mtfRefreshSymbol,
        exchange: 'binance',
        setupType: 'breakout_confirmation',
        triggerType: 'mtf_alignment',
        triggerState: 'armed',
        confidence: 0.71,
        targetPrice: 99,
        waitingFor: 'mtf_alignment',
        triggerContext: {
          hints: { mtfAgreement: 0, discoveryScore: 0.67 },
        },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      assert.ok(mtfRefreshTrigger?.id);
      const derivedEvents = await deriveMarketEvents({
        exchange: 'binance',
        limit: 50,
        ohlcvFetcher: async (requestedSymbol) => {
          if (requestedSymbol === mtfRefreshSymbol) return bullishCandles();
          return [];
        },
      });
      const mtfRefreshEvent = derivedEvents.find((item) => item.symbol === mtfRefreshSymbol);
      assert.equal(mtfRefreshEvent?.mtfDominantSignal, 'BUY', 'deriveMarketEvents should refresh missing MTF direction from OHLCV');
      assert.ok(Number(mtfRefreshEvent?.mtfAgreement || 0) > 0, 'fresh MTF agreement should be available when stored hints are empty');
      assert.equal(mtfRefreshEvent?.triggerHints?.entryTriggerMtfRefresh?.source, 'ohlcv_mtf_refresh');

      const kisMtfRefreshTrigger = await insertEntryTrigger({
        symbol: kisMtfRefreshSymbol,
        exchange: 'kis',
        setupType: 'breakout_confirmation',
        triggerType: 'mtf_alignment',
        triggerState: 'armed',
        confidence: 0.74,
        waitingFor: 'mtf_alignment',
        triggerContext: {
          hints: { discoveryScore: 0.68 },
        },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      assert.ok(kisMtfRefreshTrigger?.id);
      const kisDerivedEvents = await deriveMarketEvents({
        exchange: 'kis',
        limit: 50,
        ohlcvFetcher: async (requestedSymbol) => {
          if (requestedSymbol === kisMtfRefreshSymbol) return bullishCandles();
          return [];
        },
      });
      const kisMtfRefreshEvent = kisDerivedEvents.find((item) => item.symbol === kisMtfRefreshSymbol);
      assert.equal(kisMtfRefreshEvent?.mtfDominantSignal, 'BUY', 'non-binance entry triggers should refresh missing MTF from OHLCV fallback');
      assert.equal(kisMtfRefreshEvent?.technicalTelemetry?.mtfAvailable, true);
      assert.equal(kisMtfRefreshEvent?.technicalTelemetry?.volumeAvailable, true);
      assert.equal(kisMtfRefreshEvent?.triggerHints?.entryTriggerMtfRefresh?.exchange, 'kis');

      const bearishMtfTrigger = await insertEntryTrigger({
        symbol: bearishMtfSymbol,
        exchange: 'binance',
        setupType: 'breakout_confirmation',
        triggerType: 'mtf_alignment',
        triggerState: 'armed',
        confidence: 0.76,
        waitingFor: 'mtf_alignment',
        triggerContext: {
          hints: { mtfAgreement: 0.9, discoveryScore: 0.8 },
        },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      assert.ok(bearishMtfTrigger?.id);
      const bearishMtfResult = await evaluateActiveEntryTriggersAgainstMarketEvents([
        {
          symbol: bearishMtfSymbol,
          mtfAgreement: 1,
          mtfAlignmentScore: -0.9,
          mtfDominantSignal: 'SELL',
          discoveryScore: 0.82,
          breakoutRetest: true,
        },
      ], {
        exchange: 'binance',
        binanceTopVolumeUniverse,
      });
      assert.equal(bearishMtfResult.results[0].fired, false, 'SELL-aligned MTF must not confirm a BUY trigger');
      assert.equal(bearishMtfResult.results[0].fireReadiness.mtfBullish, false);

      const terminalLowConfTrigger = await insertEntryTrigger({
        symbol: terminalLowConfSymbol,
        exchange: 'binance',
        setupType: 'breakout_confirmation',
        triggerType: 'mtf_alignment',
        triggerState: 'armed',
        confidence: 0.35,
        waitingFor: 'mtf_alignment',
        triggerContext: {
          hints: { mtfAgreement: 0.9, discoveryScore: 0.8 },
        },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      assert.ok(terminalLowConfTrigger?.id);
      const terminalLowConfResult = await evaluateActiveEntryTriggersAgainstMarketEvents([
        {
          symbol: terminalLowConfSymbol,
          mtfAgreement: 0.9,
          mtfAlignmentScore: 0.8,
          mtfDominantSignal: 'BUY',
          discoveryScore: 0.8,
          breakoutRetest: true,
          tradingViewSnapshot: {
            ok: true,
            source: 'tradingview_ws_service',
            providerMode: 'websocket',
            market: 'tradingview',
            price: 101,
            open: 100,
            stale: false,
          },
        },
      ], {
        exchange: 'binance',
        capitalSnapshot,
        binanceTopVolumeUniverse,
      });
      assert.equal(terminalLowConfResult.results[0].state, 'expired', 'static confidence hard-fail should not stay in the active trigger loop');
      assert.equal(terminalLowConfResult.results[0].reason, 'live_risk_gate_terminal_blocked');
      const terminalLowConfRow = await db.get(`SELECT trigger_state, trigger_meta FROM entry_triggers WHERE id = $1`, [terminalLowConfTrigger.id]);
      assert.equal(terminalLowConfRow?.trigger_state, 'expired');
      assert.equal(terminalLowConfRow?.trigger_meta?.terminalBlock, true);

      const qualityBlockedTrigger = await insertEntryTrigger({
        symbol: qualityBlockedSymbol,
        exchange: 'binance',
        setupType: 'breakout_confirmation',
        triggerType: 'mtf_alignment',
        triggerState: 'armed',
        confidence: 0.82,
        predictiveScore: 0.81,
        waitingFor: 'mtf_alignment',
        triggerContext: {
          hints: { mtfAgreement: 0.9, discoveryScore: 0.82 },
        },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      assert.ok(qualityBlockedTrigger?.id);
      const qualityBlockedResult = await evaluateActiveEntryTriggersAgainstMarketEvents([
        {
          symbol: qualityBlockedSymbol,
          mtfAgreement: 0.9,
          mtfAlignmentScore: 0.8,
          mtfDominantSignal: 'BUY',
          discoveryScore: 0.82,
          breakoutRetest: true,
          tradingViewSnapshot: {
            ok: true,
            source: 'tradingview_ws_service',
            providerMode: 'websocket',
            market: 'tradingview',
            price: 101,
            open: 100,
            stale: false,
          },
        },
      ], {
        exchange: 'binance',
        capitalSnapshot,
        binanceTopVolumeUniverse,
        activeQualityGateEnabled: true,
        skipActiveQualityLoad: true,
        activeQualityBySymbol: {
          [qualityBlockedSymbol]: {
            backtest: {
              fresh: true,
              healthy: false,
              sharpe: -0.42,
              maxDrawdown: 28,
              winRate: 31,
              gateStatus: 'would_block_unhealthy',
              wouldBlock: true,
              lastBacktestAt: new Date().toISOString(),
            },
            predictive: {
              decision: 'block_backtest_gate',
              score: 0.2,
              threshold: 0.55,
              componentCoverage: 1,
              blockedReason: 'backtest_unhealthy_or_would_block',
              createdAt: new Date().toISOString(),
            },
          },
        },
      });
      assert.equal(qualityBlockedResult.results[0].fired, true, 'notify mode should allow active quality blockers through for learning data');
      assert.equal(qualityBlockedResult.fired, 1);
      assert.equal(qualityBlockedResult.qualityExpired, 0);
      const qualityBlockedRow = await db.get(`SELECT trigger_state, trigger_meta FROM entry_triggers WHERE id = $1`, [qualityBlockedTrigger.id]);
      assert.equal(qualityBlockedRow?.trigger_state, 'fired');
      await new Promise((resolve) => setTimeout(resolve, 150));
      const qualityNotifyEvent = await db.get(
        `SELECT guard_name, reason, decision_after
           FROM investment.guard_events
          WHERE guard_name = 'active_quality_gate_notify'
            AND symbol = $1
          ORDER BY triggered_at DESC
          LIMIT 1`,
        [qualityBlockedSymbol],
      );
      assert.equal(qualityNotifyEvent?.guard_name, 'active_quality_gate_notify');
      assert.ok(String(qualityNotifyEvent?.reason || '').includes('backtest_unhealthy_or_would_block'), 'notify event should preserve quality blocker reasons');
      assert.equal(qualityNotifyEvent?.decision_after?.notifyMode, true);

      const qualityHardGateTrigger = await insertEntryTrigger({
        symbol: qualityHardGateSymbol,
        exchange: 'binance',
        setupType: 'breakout_confirmation',
        triggerType: 'mtf_alignment',
        triggerState: 'armed',
        confidence: 0.82,
        predictiveScore: 0.81,
        waitingFor: 'mtf_alignment',
        triggerContext: {
          hints: { mtfAgreement: 0.9, discoveryScore: 0.82 },
        },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      assert.ok(qualityHardGateTrigger?.id);
      const qualityHardGateResult = await evaluateActiveEntryTriggersAgainstMarketEvents([
        {
          symbol: qualityHardGateSymbol,
          mtfAgreement: 0.9,
          mtfAlignmentScore: 0.8,
          mtfDominantSignal: 'BUY',
          discoveryScore: 0.82,
          breakoutRetest: true,
          tradingViewSnapshot: {
            ok: true,
            source: 'tradingview_ws_service',
            providerMode: 'websocket',
            market: 'tradingview',
            price: 101,
            open: 100,
            stale: false,
          },
        },
      ], {
        exchange: 'binance',
        capitalSnapshot,
        binanceTopVolumeUniverse,
        activeQualityGateEnabled: true,
        activeQualityGateMode: 'hard_gate',
        skipActiveQualityLoad: true,
        activeQualityBySymbol: {
          [qualityHardGateSymbol]: {
            backtest: {
              fresh: true,
              healthy: false,
              sharpe: -0.42,
              maxDrawdown: 28,
              winRate: 31,
              gateStatus: 'would_block_unhealthy',
              wouldBlock: true,
              lastBacktestAt: new Date().toISOString(),
            },
            predictive: {
              decision: 'block_backtest_gate',
              score: 0.2,
              threshold: 0.55,
              componentCoverage: 1,
              blockedReason: 'backtest_unhealthy_or_would_block',
              createdAt: new Date().toISOString(),
            },
          },
        },
      });
      assert.equal(qualityHardGateResult.results[0].fired, false, 'hard_gate mode should preserve previous active quality blocking behavior');
      assert.equal(qualityHardGateResult.results[0].reason, 'active_entry_trigger_quality_terminal_blocked');
      assert.equal(qualityHardGateResult.results[0].state, 'expired');
      assert.equal(qualityHardGateResult.qualityExpired, 1);
      assert.equal(qualityHardGateResult.results[0].qualityGate.notifyMode, false);
      const qualityHardGateRow = await db.get(`SELECT trigger_state, trigger_meta FROM entry_triggers WHERE id = $1`, [qualityHardGateTrigger.id]);
      assert.equal(qualityHardGateRow?.trigger_state, 'expired');
      assert.equal(qualityHardGateRow?.trigger_meta?.reason, 'active_entry_trigger_quality_terminal_blocked');
      assert.equal(qualityHardGateRow?.trigger_meta?.terminalBlock, true);

      const dsrQualitySymbol = `DSRQUALITY${Date.now().toString(36).toUpperCase()}/USDT`;
      const dsrQualityMap = await withEnv({ LUNA_DSR_GATE_ENABLED: 'true' }, () => loadActiveEntryTriggerQuality([dsrQualitySymbol], {
        market: 'crypto',
        queryFn: async (sql) => {
          const statement = String(sql || '');
          if (statement.includes('candidate_backtest_status')) {
            return [{
              symbol: dsrQualitySymbol,
              market: 'crypto',
              fresh: true,
              healthy: true,
              sharpe: 1.2,
              max_drawdown: 10,
              win_rate: 55,
              last_backtest_at: new Date().toISOString(),
              gate_status: 'pass',
              would_block: false,
              block_reasons: [],
              updated_at: new Date().toISOString(),
              total_trades_oos: 45,
              dsr: 0.42,
            }];
          }
          if (statement.includes('predictive_validation_log')) {
            return [{
              symbol: dsrQualitySymbol,
              market: 'crypto',
              decision: 'pass',
              score: 0.82,
              threshold: 0.55,
              component_coverage: 1,
              blocked_reason: null,
              created_at: new Date().toISOString(),
            }];
          }
          return [];
        },
      }));
      const dsrQuality = dsrQualityMap.get(dsrQualitySymbol);
      assert.equal(dsrQuality?.backtest?.healthy, false, 'enabled DSR gate should downgrade stored healthy rows at entry-trigger load time');
      assert.equal(dsrQuality?.backtest?.wouldBlock, true, 'enabled DSR gate should make low-DSR stored rows would-block');
      assert.ok(
        dsrQuality?.backtest?.blockReasons?.some((reason) => String(reason).startsWith('candidate_backtest_dsr_low')),
        'entry-trigger quality load should preserve explicit low-DSR reason',
      );
      const dsrQualityGate = evaluateActiveEntryTriggerQualityGate(
        { symbol: dsrQualitySymbol },
        dsrQuality,
        { activeQualityGateEnabled: true, activeQualityGateMode: 'hard_gate' },
      );
      assert.equal(dsrQualityGate.ok, false, 'hard_gate should block entry triggers when stored DSR is below threshold');
      assert.equal(dsrQualityGate.reason, 'backtest_unhealthy_or_would_block');
      assert.equal(dsrQualityGate.backtest?.dsr, 0.42);
      const dsrNotifyGate = evaluateActiveEntryTriggerQualityGate(
        { symbol: dsrQualitySymbol },
        dsrQuality,
        { activeQualityGateEnabled: true, activeQualityGateMode: 'notify' },
      );
      assert.equal(dsrNotifyGate.notifyMode, true, 'DSR-only hard block should not require global active quality hard_gate');
      assert.equal(dsrNotifyGate.hardBlock, true, 'enabled DSR gate should hard-block low DSR rows even in notify mode');
      assert.equal(dsrNotifyGate.ok, false, 'notify mode must not allow DSR-gated backtests through');
      assert.equal(dsrNotifyGate.hardBlockReason, 'candidate_backtest_dsr_gate');

      const qualityPredictiveFallbackTrigger = await insertEntryTrigger({
        symbol: qualityPredictiveFallbackSymbol,
        exchange: 'binance',
        setupType: 'promotion_ready_shadow',
        triggerType: 'mtf_alignment',
        triggerState: 'armed',
        confidence: 0.72,
        waitingFor: 'mtf_alignment',
        triggerContext: {
          hints: {
            discoveryScore: 0.72,
            promotionReady: true,
            promotionPassCount: 8,
            promotionConsecutivePasses: 6,
          },
        },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      assert.ok(qualityPredictiveFallbackTrigger?.id);
      const qualityPredictiveFallbackResult = await evaluateActiveEntryTriggersAgainstMarketEvents([
        {
          symbol: qualityPredictiveFallbackSymbol,
          mtfAgreement: 0,
          mtfAlignmentScore: 0,
          discoveryScore: 0.72,
        },
      ], {
        exchange: 'binance',
        binanceTopVolumeUniverse,
        activeQualityGateEnabled: true,
        skipActiveQualityLoad: true,
        activeQualityBySymbol: {
          [qualityPredictiveFallbackSymbol]: {
            backtest: {
              fresh: true,
              healthy: true,
              sharpe: 1.1,
              maxDrawdown: 12,
              winRate: 55,
              gateStatus: 'pass',
              wouldBlock: false,
              lastBacktestAt: new Date().toISOString(),
            },
            predictive: {
              decision: 'fire',
              score: 0.77,
              threshold: 0.55,
              componentCoverage: 1,
              createdAt: new Date().toISOString(),
            },
          },
        },
      });
      assert.equal(qualityPredictiveFallbackResult.results[0].fired, false, 'missing MTF should still wait');
      assert.equal(qualityPredictiveFallbackResult.results[0].fireReadiness.predictiveScore, 0.77, 'fire readiness should reuse latest active quality predictive score when trigger score is missing');

      const dryRunFireTrigger = await insertEntryTrigger({
        symbol: dryRunFireSymbol,
        exchange: 'binance',
        setupType: 'breakout_confirmation',
        triggerType: 'mtf_alignment',
        triggerState: 'armed',
        confidence: 0.81,
        predictiveScore: 0.78,
        waitingFor: 'mtf_alignment',
        triggerContext: {
          hints: { mtfAgreement: 0.9, discoveryScore: 0.81 },
        },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      assert.ok(dryRunFireTrigger?.id);
      const dryRunFireResult = await evaluateActiveEntryTriggersAgainstMarketEvents([
        {
          symbol: dryRunFireSymbol,
          mtfAgreement: 0.9,
          mtfAlignmentScore: 0.84,
          mtfDominantSignal: 'BUY',
          discoveryScore: 0.81,
          breakoutRetest: true,
          tradingViewSnapshot: {
            ok: true,
            source: 'tradingview_ws_service',
            providerMode: 'websocket',
            market: 'tradingview',
            price: 101,
            open: 100,
            stale: false,
          },
        },
      ], {
        exchange: 'binance',
        capitalSnapshot,
        binanceTopVolumeUniverse,
        dryRun: true,
      });
      assert.equal(dryRunFireResult.dryRun, true);
      assert.equal(dryRunFireResult.results.find((item) => item.symbol === dryRunFireSymbol)?.fired, true, 'dry-run should still expose would-fire readiness');
      const dryRunFireRow = await db.get(`SELECT trigger_state, fired_at FROM entry_triggers WHERE id = $1`, [dryRunFireTrigger.id]);
      assert.equal(dryRunFireRow?.trigger_state, 'armed', 'dry-run must not mutate trigger state to fired');
      assert.equal(dryRunFireRow?.fired_at, null, 'dry-run must not stamp fired_at');

      const missingEventTrigger = await insertEntryTrigger({
        symbol: missingEventSymbol,
        exchange: 'binance',
        setupType: 'breakout_confirmation',
        triggerType: 'mtf_alignment',
        triggerState: 'armed',
        confidence: 0.79,
        predictiveScore: 0.75,
        waitingFor: 'mtf_alignment',
        triggerContext: {
          hints: { mtfAgreement: 0.9, discoveryScore: 0.79 },
        },
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });
      assert.ok(missingEventTrigger?.id);
      const missingEventResult = await evaluateActiveEntryTriggersAgainstMarketEvents([], {
        exchange: 'binance',
        capitalSnapshot,
        binanceTopVolumeUniverse,
        dryRun: true,
        reportMissingMarketEvents: true,
      });
      const missingEventItem = missingEventResult.results.find((item) => item.symbol === missingEventSymbol);
      assert.equal(missingEventItem?.reason, 'market_event_missing', 'explicit missing-event reporting should expose active triggers with no market event');
      assert.equal(missingEventItem?.fireReadiness?.technicalTelemetry?.missing, true);
      const missingEventRow = await db.get(`SELECT trigger_state, trigger_meta FROM entry_triggers WHERE id = $1`, [missingEventTrigger.id]);
      assert.equal(missingEventRow?.trigger_state, 'armed', 'dry-run missing-event reporting must not mutate trigger state');
      assert.equal(missingEventRow?.trigger_meta?.reason, undefined, 'dry-run missing-event reporting must not write trigger meta');

      const workerRiskContext = await buildEntryTriggerWorkerRiskContext({
        exchange: 'binance',
        buyingPowerSnapshotBuilder: async () => capitalSnapshot,
      });
      assert.equal(workerRiskContext.capitalSnapshot.mode, 'ACTIVE_DISCOVERY');
      assert.equal(workerRiskContext.capitalSnapshot.buyableAmount, 500);

      const materializedPayloads = [];
      const materializedMeta = [];
      const materializedUpdates = [];
      const readyTradeDataHygieneBuilder = async () => ({
        ok: true,
        status: 'ready',
        severity: 'none',
        blockers: [],
        generatedAt: new Date().toISOString(),
      });
      const materializeResult = await materializeFiredEntryTriggerSignals({
        exchange: 'binance',
        result: {
          allowLiveFire: true,
          results: [{ triggerId: 'fake-trigger-1', symbol: 'FAKE/USDT', fired: true }],
        },
        riskContext: { capitalSnapshot },
        events: [{ symbol: 'FAKE/USDT', price: 101, targetPrice: 101 }],
        deps: {
          binanceTopVolumeUniverse,
          tradeDataHygieneBuilder: readyTradeDataHygieneBuilder,
          triggerFetcher: async () => ({
            id: 'fake-trigger-1',
            symbol: 'FAKE/USDT',
            exchange: 'binance',
            setup_type: 'mean_reversion',
            trigger_type: 'pullback_to_support',
            trigger_state: 'fired',
            confidence: 0.73,
            predictive_score: 0.63,
            trigger_context: {
              strategyRoute: {
                selectedFamily: 'mean_reversion',
                setupType: 'pullback_to_support',
                quality: 'watch',
                readinessScore: 0.66,
                hasTechnicalPresignal: true,
                externalEvidence: {
                  evidenceCount: 3,
                  sourceCount: 2,
                  avgQuality: 0.72,
                  avgFreshness: 0.8,
                },
              },
              strategyQuality: 'watch',
              strategyReadiness: 0.66,
            },
            trigger_meta: {},
          }),
          duplicateFinder: async () => null,
          signalInserter: async (payload) => {
            materializedPayloads.push(payload);
            return 'fake-signal-1';
          },
          blockMetaMerger: async (id, meta) => {
            materializedMeta.push({ id, meta });
          },
          triggerUpdater: async (id, patch) => {
            materializedUpdates.push({ id, patch });
          },
        },
      });
      assert.equal(materializeResult.enabled, true);
      assert.equal(materializeResult.materialized, 1);
      assert.equal(materializedPayloads[0].status, 'approved');
      assert.equal(materializedPayloads[0].executionOrigin, 'entry_trigger');
      assert.equal(materializedPayloads[0].nemesisVerdict, 'approved');
      assert.equal(materializedPayloads[0].amountUsdt, 50);
      assert.equal(materializedPayloads[0].strategyFamily, 'mean_reversion');
      assert.equal(materializedPayloads[0].strategyQuality, 'watch');
      assert.equal(materializedPayloads[0].strategyReadiness, 0.66);
      assert.equal(materializedPayloads[0].strategyRoute.readinessScore, 0.66);
      assert.equal(materializedMeta[0].meta.event_type, 'entry_trigger_fired_signal_materialized');
      assert.equal(materializedMeta[0].meta.entryTrigger.strategy.quality, 'watch');
      assert.equal(materializedUpdates[0].patch.triggerMetaPatch.materializeStatus, 'approved_signal_inserted');

      const hygieneBlockedUpdates = [];
      const hygieneBlockedPayloads = [];
      const hygieneBlockedResult = await materializeFiredEntryTriggerSignals({
        exchange: 'binance',
        result: {
          allowLiveFire: true,
          results: [{ triggerId: 'fake-trigger-hygiene', symbol: 'FAKE/USDT', fired: true }],
        },
        riskContext: { capitalSnapshot },
        events: [{ symbol: 'FAKE/USDT', price: 101, targetPrice: 101 }],
        deps: {
          binanceTopVolumeUniverse,
          tradeDataHygieneBuilder: async () => ({
            ok: false,
            status: 'needs_attention',
            severity: 'P0',
            blockers: ['trade_data_hygiene:open_journal_reconcile_pending'],
          }),
          triggerFetcher: async () => ({
            id: 'fake-trigger-hygiene',
            symbol: 'FAKE/USDT',
            exchange: 'binance',
            setup_type: 'mean_reversion',
            trigger_type: 'pullback_to_support',
            trigger_state: 'fired',
            confidence: 0.73,
            predictive_score: 0.63,
            trigger_context: {
              strategyRoute: {
                selectedFamily: 'mean_reversion',
                setupType: 'pullback_to_support',
                quality: 'watch',
                readinessScore: 0.66,
                hasTechnicalPresignal: true,
                externalEvidence: {
                  evidenceCount: 3,
                  sourceCount: 2,
                  avgQuality: 0.72,
                  avgFreshness: 0.8,
                },
              },
            },
            trigger_meta: {},
          }),
          duplicateFinder: async () => null,
          signalInserter: async (payload) => {
            hygieneBlockedPayloads.push(payload);
            return 'should-not-insert';
          },
          blockMetaMerger: async () => null,
          triggerUpdater: async (id, patch) => {
            hygieneBlockedUpdates.push({ id, patch });
          },
        },
      });
      assert.equal(hygieneBlockedResult.materialized, 0);
      assert.equal(hygieneBlockedResult.skipped, 1);
      assert.equal(hygieneBlockedPayloads.length, 0);
      assert.equal(hygieneBlockedResult.items[0].reason, 'trade_data_hygiene_not_ready');
      assert.equal(hygieneBlockedUpdates[0].patch.triggerMetaPatch.materializeStatus, 'blocked_by_trade_data_hygiene');

      const blockedPayloads = [];
      const blockedUpdates = [];
      const blockedMaterializeResult = await materializeFiredEntryTriggerSignals({
        exchange: 'binance',
        result: {
          allowLiveFire: true,
          results: [{ triggerId: 'fake-trigger-rlusd', symbol: 'RLUSD/USDT', fired: true }],
        },
        riskContext: { capitalSnapshot },
        events: [{ symbol: 'RLUSD/USDT', price: 1, targetPrice: 1 }],
        deps: {
          binanceTopVolumeUniverse,
          tradeDataHygieneBuilder: readyTradeDataHygieneBuilder,
          triggerFetcher: async () => ({
            id: 'fake-trigger-rlusd',
            symbol: 'RLUSD/USDT',
            exchange: 'binance',
            setup_type: 'mean_reversion',
            trigger_type: 'pullback_to_support',
            trigger_state: 'fired',
            confidence: 0.91,
            predictive_score: 0.81,
            trigger_context: {
              strategyRoute: {
                selectedFamily: 'mean_reversion',
                setupType: 'pullback_to_support',
                quality: 'ready',
                readinessScore: 0.82,
              },
            },
            trigger_meta: {},
          }),
          duplicateFinder: async () => null,
          signalInserter: async (payload) => {
            blockedPayloads.push(payload);
            return 'should-not-insert';
          },
          blockMetaMerger: async () => null,
          triggerUpdater: async (id, patch) => {
            blockedUpdates.push({ id, patch });
          },
        },
      });
      assert.equal(blockedMaterializeResult.materialized, 0);
      assert.equal(blockedMaterializeResult.skipped, 1);
      assert.equal(blockedPayloads.length, 0);
      assert.equal(blockedMaterializeResult.items[0].reason, 'trade_data_entry_guard_hard_blocked');
      assert.equal(blockedUpdates[0].patch.triggerMetaPatch.materializeStatus, 'blocked_by_trade_data_entry_guard');

      const trendNoMtfPayloads = [];
      const trendNoMtfUpdates = [];
      const trendNoMtfResult = await materializeFiredEntryTriggerSignals({
        exchange: 'binance',
        result: {
          allowLiveFire: true,
          results: [{ triggerId: 'fake-trigger-trend-no-mtf', symbol: trendingBullNoMtfSymbol, fired: true }],
        },
        riskContext: { capitalSnapshot },
        events: [{ symbol: trendingBullNoMtfSymbol, price: 10, targetPrice: 10 }],
        deps: {
          binanceTopVolumeUniverse,
          tradeDataHygieneBuilder: readyTradeDataHygieneBuilder,
          triggerFetcher: async () => ({
            id: 'fake-trigger-trend-no-mtf',
            symbol: trendingBullNoMtfSymbol,
            exchange: 'binance',
            setup_type: 'trend_following',
            trigger_type: 'breakout_retest',
            trigger_state: 'fired',
            confidence: 0.82,
            predictive_score: 0.8,
            trigger_context: {
              marketRegime: 'trending_bull',
              hasTechnicalPresignal: false,
              strategyRoute: {
                selectedFamily: 'trend_following',
                setupType: 'breakout_retest',
                quality: 'ready',
                readinessScore: 0.84,
              },
            },
            trigger_meta: {},
          }),
          duplicateFinder: async () => null,
          signalInserter: async (payload) => {
            trendNoMtfPayloads.push(payload);
            return 'should-not-insert';
          },
          blockMetaMerger: async () => null,
          triggerUpdater: async (id, patch) => {
            trendNoMtfUpdates.push({ id, patch });
          },
        },
      });
      assert.equal(trendNoMtfResult.materialized, 1);
      assert.equal(trendNoMtfResult.skipped, 0);
      assert.equal(trendNoMtfPayloads.length, 1);
      assert.equal(trendNoMtfResult.items[0].status, 'materialized');
      assert.ok(
        trendNoMtfUpdates.some((item) => item.patch?.triggerMetaPatch?.tradeDataGuardNotify?.blockers?.includes('crypto_trending_bull_without_mtf_confirmation')),
        'trending_bull trigger context must reach trade-data entry guard notify path',
      );
      assert.ok(
        trendNoMtfUpdates.some((item) => item.patch?.triggerMetaPatch?.materializeStatus === 'approved_signal_inserted'),
        'notify path must keep materializing approved signal',
      );

      return {
        ok: true,
        triggerId: trigger.id,
        result,
        pullbackResult,
        openEventResult,
        workerRiskContext,
        materializeResult,
      };
    } finally {
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [symbol]).catch(() => {});
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [pullbackSymbol]).catch(() => {});
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [refreshSymbol]).catch(() => {});
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [openSymbol]).catch(() => {});
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [mtfRefreshSymbol]).catch(() => {});
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [kisMtfRefreshSymbol]).catch(() => {});
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [bearishMtfSymbol]).catch(() => {});
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [weakPullbackSymbol]).catch(() => {});
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [technicalProbePullbackSymbol]).catch(() => {});
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [dryRunFireSymbol]).catch(() => {});
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [missingEventSymbol]).catch(() => {});
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [terminalLowConfSymbol]).catch(() => {});
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [qualityBlockedSymbol]).catch(() => {});
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [qualityHardGateSymbol]).catch(() => {});
      await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [qualityPredictiveFallbackSymbol]).catch(() => {});
      await db.run(
        `DELETE FROM investment.guard_events
          WHERE symbol IN ($1, $2) AND guard_name = 'active_quality_gate_notify'`,
        [qualityBlockedSymbol, qualityHardGateSymbol],
      ).catch(() => {});
      await db.run(`DELETE FROM entry_triggers WHERE symbol LIKE 'STALEBLOCK%'`).catch(() => {});
      if (signalId) await db.run(`DELETE FROM signals WHERE id = $1`, [signalId]).catch(() => {});
      if (openSignalId) await db.run(`DELETE FROM signals WHERE id = $1`, [openSignalId]).catch(() => {});
      if (smokeOriginSignalId) await db.run(`DELETE FROM signals WHERE id = $1`, [smokeOriginSignalId]).catch(() => {});
    }
  });
}

async function main() {
  const result = await runLunaEntryTriggerActiveWorkerSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna entry trigger active-worker smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna entry-trigger active-worker smoke 실패:',
  });
}
