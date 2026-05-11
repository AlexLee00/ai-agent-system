#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as db from '../shared/db.ts';
import { ensureCandidateUniverseTable } from '../team/discovery/discovery-store.ts';
import { ensureLunaDiscoveryEntryTables } from '../shared/luna-discovery-entry-store.ts';
import {
  buildDailyTechnicalCoverage,
  buildLunaDiscoveryFunnelReport,
  buildRequiredCoverageSymbols,
  buildRequiredAnalystCoverage,
  classifyEntryPrefilterWaitState,
  classifySignalPersistenceState,
  classifyCoverageBottlenecksForMarket,
  filterEntryDecisionDiagnosticsForOpenPositions,
  getRequiredAnalystsForMarket,
  summarizeRecentEntryTriggerPipelineEvidence,
} from './runtime-luna-discovery-funnel-report.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function seedFixture(symbol, historyFile) {
  await db.run(
    `INSERT INTO candidate_universe
       (symbol, market, source, source_tier, score, confidence, reason, reason_code, ttl_hours, raw_data, expires_at)
     VALUES
       ($1, 'crypto', 'smoke_funnel', 1, 0.84, 0.80, 'smoke candidate', 'smoke_ready', 2, '{}'::jsonb, now() + interval '2 hours')
     ON CONFLICT (symbol, market, source) DO UPDATE SET
       score = excluded.score,
       confidence = excluded.confidence,
       discovered_at = now(),
       expires_at = now() + interval '2 hours'`,
    [symbol],
  );
  await db.run(
    `INSERT INTO discovery_source_metrics
       (id, source, market, quality_status, signal_count, reliability, freshness_score, confidence_score, notes, raw_meta)
     VALUES
       ($1, 'smoke_funnel', 'crypto', 'ready', 1, 0.9, 1, 0.85, 'smoke', '{}'::jsonb)`,
    [`smoke-funnel-metric-${symbol}`],
  );
  await db.run(
    `INSERT INTO signals
       (symbol, action, amount_usdt, confidence, reasoning, status, exchange, trade_mode)
     VALUES
       ($1, 'BUY', 25, 0.82, 'smoke funnel signal', 'approved', 'binance', 'normal')`,
    [symbol],
  );
  await db.insertAnalysis({
    symbol,
    analyst: 'smoke_funnel',
    signal: 'BUY',
    confidence: 0.82,
    reasoning: 'smoke funnel analysis',
    metadata: { smoke: true },
    exchange: 'binance',
  });
  await db.run(
    `INSERT INTO signals
       (symbol, action, amount_usdt, confidence, reasoning, status, exchange, trade_mode, block_code, block_reason, quality_flag, exclude_from_learning)
     VALUES
       ($1, 'BUY', 25, 0.10, 'reflection smoke', 'failed', 'binance', 'normal', 'synthetic_reflection_signal', 'reflection smoke signal excluded from execution queue', 'exclude_from_learning', true)`,
    [`REFLECT_${Date.now()}`],
  );
  await db.run(
    `INSERT INTO entry_triggers
       (id, symbol, exchange, trigger_type, trigger_state, confidence, predictive_score, expires_at, trigger_context, trigger_meta, updated_at)
     VALUES
       ($1, $2, 'binance', 'smoke_funnel', 'armed', 0.82, 0.78, now() + interval '2 hours', '{}'::jsonb, '{}'::jsonb, now())`,
    [`smoke-funnel-trigger-${symbol}`, symbol],
  );
  fs.writeFileSync(historyFile, `${JSON.stringify({
    recordedAt: new Date().toISOString(),
    status: 'position_runtime_autopilot_executed',
    dispatchCandidateCount: 1,
    dispatchExecutedCount: 0,
    dispatchQueuedCount: 0,
    dispatchRetryingCount: 0,
    dispatchSkippedCount: 0,
    dispatchFailureCount: 0,
    dispatchMarketQueue: { total: 0, waitingMarketOpen: 0 },
  })}\n`);
}

async function cleanupFixture(symbol) {
  await db.run(`DELETE FROM entry_triggers WHERE symbol = $1`, [symbol]).catch(() => null);
  await db.run(`DELETE FROM signals WHERE symbol = $1 AND reasoning = 'smoke funnel signal'`, [symbol]).catch(() => null);
  await db.run(`DELETE FROM analysis WHERE symbol = $1 AND analyst = 'smoke_funnel'`, [symbol]).catch(() => null);
  await db.run(`DELETE FROM signals WHERE symbol LIKE 'REFLECT_%' AND block_code = 'synthetic_reflection_signal' AND reasoning = 'reflection smoke'`).catch(() => null);
  await db.run(`DELETE FROM discovery_source_metrics WHERE id = $1`, [`smoke-funnel-metric-${symbol}`]).catch(() => null);
  await db.run(`DELETE FROM candidate_universe WHERE symbol = $1 AND source = 'smoke_funnel'`, [symbol]).catch(() => null);
}

export async function runLunaDiscoveryFunnelReportSmoke() {
  await db.initSchema();
  await ensureCandidateUniverseTable();
  await ensureLunaDiscoveryEntryTables();
  const symbol = `FUNNEL${Date.now()}/USDT`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-funnel-'));
  const historyFile = path.join(dir, 'history.jsonl');
  try {
    await seedFixture(symbol, historyFile);
    const report = await buildLunaDiscoveryFunnelReport({
      hours: 1,
      market: 'crypto',
      historyFile,
    });
    const crypto = report.markets.find((item) => item.market === 'crypto');
    assert.equal(report.ok, true);
    assert.ok(crypto, 'crypto market report should exist');
    assert.ok(crypto.candidateUniverse.activeCount >= 1, 'candidate universe should include smoke candidate');
    assert.ok(crypto.analysisCoverage.coveredCount >= 1, 'analysis coverage should include smoke candidate');
    assert.ok(crypto.signalPersistence.buyCount >= 1, 'signal persistence should include smoke BUY');
    assert.ok(crypto.signalPersistence.triggerEligibleBuyCount >= 1, 'trigger eligibility should only count live BUY signals');
    assert.ok(crypto.signalPersistence.byBlockCode.none >= 1, 'signal persistence should expose non-blocked BUY/SIGNAL rows');
    assert.ok(crypto.signalPersistence.ignoredCount >= 1, 'synthetic reflection signal should be tracked as ignored');
    assert.ok(crypto.entryTriggers.activeCount >= 1, 'entry trigger should include smoke armed trigger');
    assert.equal(report.autopilot.totals.candidateCount, 1, 'autopilot dispatch candidate count should come from fixture history');
    assert.equal(report.nextAction, 'continue_observation', 'complete fixture funnel should not request repair action');

    const filteredDecisionScope = filterEntryDecisionDiagnosticsForOpenPositions([
      { symbol: 'BTC/USDT', actionability: 'relaxed_probe_candidate' },
      { symbol: 'NEW/USDT', actionability: 'likely_actionable' },
    ], new Set(['BTC/USDT']));
    assert.deepEqual(
      filteredDecisionScope.included.map((item) => item.symbol),
      ['NEW/USDT'],
      'open positions should not be reported as new entry decision candidates',
    );
    assert.deepEqual(
      filteredDecisionScope.excluded.map((item) => item.symbol),
      ['BTC/USDT'],
      'open-position decision candidates should remain auditable as excluded',
    );
    const blockedEntryTriggerEvidence = summarizeRecentEntryTriggerPipelineEvidence([
      {
        session_id: 'entry-trigger-blocked-smoke',
        status: 'completed',
        started_at: Date.now(),
        meta: {
          decision_count: 1,
          buy_decisions: 0,
          hold_decisions: 1,
          approved_signals: 0,
          entry_trigger_stats: {
            enabled: true,
            shouldMutate: true,
            allowLiveFire: true,
            blocked: 1,
            armed: 0,
            fired: 0,
            observed: 0,
          },
        },
      },
    ]);
    assert.equal(
      blockedEntryTriggerEvidence.blockedBeforeSignalPersistence,
      true,
      'recent entry-trigger blocks should be exposed as signal-persistence evidence',
    );
    assert.deepEqual(
      classifySignalPersistenceState({
        marketOpen: true,
        likelyActionableCount: 1,
        recentBuySignals: 0,
        pipelineEntryTriggerEvidence: blockedEntryTriggerEvidence,
      }),
      {
        bottleneck: null,
        observation: 'entry_trigger_gate_blocked_before_signal_persistence',
        recommendationEligible: false,
      },
      'entry-trigger gate blocks should not be classified as signal persistence repair gaps',
    );
    assert.equal(
      classifySignalPersistenceState({
        marketOpen: true,
        likelyActionableCount: 1,
        recentBuySignals: 0,
        pipelineEntryTriggerEvidence: summarizeRecentEntryTriggerPipelineEvidence([]),
      }).bottleneck,
      'actionable_candidate_waiting_signal_persistence',
      'missing BUY persistence without entry-trigger evidence should remain a repair gap',
    );
    const stockMarketWait = classifyEntryPrefilterWaitState({
      market: 'overseas',
      marketOpen: true,
      activeCandidateCount: 20,
      recentSignalCount: 0,
      activeTriggerCount: 0,
      recentBuySignals: 0,
      analysisCoveredCount: 20,
      likelyActionableCount: 0,
      relaxedProbeCount: 0,
      requiredCoverageBottlenecks: [],
      decisionDiagnostics: [
        {
          symbol: 'AAPL',
          actionability: 'not_actionable',
          reasons: ['fusion_not_long', 'technical_not_confirmed', 'market_flow_not_confirmed'],
        },
        {
          symbol: 'NVDA',
          actionability: 'not_actionable',
          reasons: ['fusion_not_long', 'average_confidence_below_min', 'market_flow_not_confirmed'],
        },
      ],
    });
    assert.equal(
      stockMarketWait.suppressBottleneck,
      true,
      'fully covered stock candidates waiting on flow/technical confirmation should be market-condition observations',
    );
    assert.equal(stockMarketWait.observation, 'stock_entry_prefilter_market_condition_wait');
    assert.equal(
      classifyEntryPrefilterWaitState({
        market: 'overseas',
        marketOpen: true,
        activeCandidateCount: 20,
        recentSignalCount: 0,
        activeTriggerCount: 0,
        recentBuySignals: 0,
        analysisCoveredCount: 20,
        likelyActionableCount: 0,
        relaxedProbeCount: 0,
        requiredCoverageBottlenecks: [],
        decisionDiagnostics: [
          { symbol: 'AAPL', actionability: 'not_actionable', reasons: ['conflict_detected', 'market_flow_not_confirmed'] },
        ],
      }).suppressBottleneck,
      false,
      'hard filter reasons should remain actionable bottlenecks',
    );
    assert.equal(
      classifyEntryPrefilterWaitState({
        market: 'overseas',
        marketOpen: true,
        activeCandidateCount: 20,
        recentSignalCount: 0,
        activeTriggerCount: 0,
        recentBuySignals: 0,
        analysisCoveredCount: 20,
        likelyActionableCount: 0,
        relaxedProbeCount: 0,
        requiredCoverageBottlenecks: ['market_flow_analysis_partial_for_candidates'],
        decisionDiagnostics: [
          { symbol: 'AAPL', actionability: 'not_actionable', reasons: ['market_flow_not_confirmed'] },
        ],
      }).suppressBottleneck,
      false,
      'required evidence gaps should remain repair candidates instead of market-condition waits',
    );
    assert.deepEqual(
      getRequiredAnalystsForMarket('domestic', { LUNA_STOCK_INTRADAY_ENRICHMENT_ENABLED: 'false' }),
      ['ta_mtf', 'market_flow'],
      'stock light-collect policy should not report missing sentiment as a required-analysis bottleneck',
    );
    assert.deepEqual(
      getRequiredAnalystsForMarket('domestic', { LUNA_STOCK_INTRADAY_ENRICHMENT_ENABLED: 'true' }),
      ['ta_mtf', 'sentiment', 'market_flow'],
      'explicit stock enrichment should restore sentiment as required evidence',
    );
    const stockLightCoverage = buildRequiredAnalystCoverage({
      market: 'domestic',
      marketOpen: true,
      analysisSymbols: ['005930'],
      analysisRows: [
        { symbol: '005930', analyst: 'ta_mtf', count: 1, latest_created_at: new Date().toISOString() },
        { symbol: '005930', analyst: 'market_flow', count: 1, latest_created_at: new Date().toISOString() },
      ],
      env: { LUNA_STOCK_INTRADAY_ENRICHMENT_ENABLED: 'false' },
    });
    assert.equal(
      stockLightCoverage.bottlenecks.includes('sentiment_analysis_missing_for_candidates'),
      false,
      'stock light-collect policy should avoid unfulfillable sentiment preopen gaps',
    );

    const overseasClosedCoverage = buildRequiredAnalystCoverage({
      market: 'overseas',
      marketOpen: false,
      analysisSymbols: ['NVDA'],
      analysisRows: [
        { symbol: 'NVDA', analyst: 'sentiment', count: 1, latest_created_at: new Date().toISOString() },
        { symbol: 'NVDA', analyst: 'market_flow', count: 1, latest_created_at: new Date().toISOString() },
      ],
    });
    assert.ok(
      overseasClosedCoverage.bottlenecks.includes('technical_analysis_deferred_until_market_open'),
      'overseas missing TA should be marked as deferred when market is closed',
    );
    const overseasClosedClassified = classifyCoverageBottlenecksForMarket({
      market: 'overseas',
      marketOpen: false,
      preopenActive: true,
      bottlenecks: ['sentiment_analysis_missing_for_candidates'],
    });
    assert.deepEqual(
      overseasClosedClassified.bottlenecks,
      [],
      'closed overseas required-analysis gaps should not be live blockers',
    );
    assert.deepEqual(
      overseasClosedClassified.observations,
      ['preopen_sentiment_analysis_missing_for_candidates'],
      'closed overseas required-analysis gaps should be preserved as pre-open observations',
    );
    const overseasClosedBeforePreopen = classifyCoverageBottlenecksForMarket({
      market: 'overseas',
      marketOpen: false,
      preopenActive: false,
      bottlenecks: ['sentiment_analysis_missing_for_candidates'],
    });
    assert.deepEqual(
      overseasClosedBeforePreopen.bottlenecks,
      [],
      'closed overseas required-analysis gaps should not be blockers before pre-open window starts',
    );
    assert.deepEqual(
      overseasClosedBeforePreopen.observations,
      ['market_closed_preopen_window_not_started'],
      'closed overseas gaps should avoid preopen pending noise before the prep window',
    );
    const overseasClosedDailyReady = buildRequiredAnalystCoverage({
      market: 'overseas',
      marketOpen: false,
      analysisSymbols: ['NVDA'],
      analysisRows: [
        { symbol: 'NVDA', analyst: 'sentiment', count: 1, latest_created_at: new Date().toISOString() },
        { symbol: 'NVDA', analyst: 'market_flow', count: 1, latest_created_at: new Date().toISOString() },
      ],
      dailyTechnicalCoverage: { availableCount: 1, bullishCount: 1 },
    });
    assert.equal(
      overseasClosedDailyReady.bottlenecks.includes('technical_analysis_deferred_until_market_open'),
      false,
      'KIS daily technical coverage should prevent closed-market TA deferral from being reported as a blocker',
    );

    const domesticPartialCoverage = buildRequiredAnalystCoverage({
      market: 'domestic',
      marketOpen: true,
      analysisSymbols: ['005930', '000660'],
      analysisRows: [
        { symbol: '005930', analyst: 'ta_mtf', count: 1, latest_created_at: new Date().toISOString() },
        { symbol: '005930', analyst: 'sentiment', count: 1, latest_created_at: new Date().toISOString() },
        { symbol: '005930', analyst: 'market_flow', count: 1, latest_created_at: new Date().toISOString() },
      ],
    });
    assert.ok(
      domesticPartialCoverage.bottlenecks.includes('technical_analysis_partial_for_candidates'),
      'partial domestic TA coverage should be visible as a bottleneck',
    );
    const domesticDailyFallbackCoverage = buildRequiredAnalystCoverage({
      market: 'domestic',
      marketOpen: true,
      analysisSymbols: ['005930', '000660'],
      analysisRows: [
        { symbol: '005930', analyst: 'ta_mtf', count: 1, latest_created_at: new Date().toISOString() },
        { symbol: '005930', analyst: 'sentiment', count: 1, latest_created_at: new Date().toISOString() },
        { symbol: '005930', analyst: 'market_flow', count: 1, latest_created_at: new Date().toISOString() },
        { symbol: '000660', analyst: 'sentiment', count: 1, latest_created_at: new Date().toISOString() },
        { symbol: '000660', analyst: 'market_flow', count: 1, latest_created_at: new Date().toISOString() },
      ],
      dailyTechnicalCoverage: {
        rows: [{ symbol: '000660', source: 'kis_domestic_daily_price', bars: 90, ok: true }],
      },
    });
    assert.equal(
      domesticDailyFallbackCoverage.bottlenecks.includes('technical_analysis_partial_for_candidates'),
      false,
      'KIS daily technical coverage should count as domestic TA coverage evidence',
    );
    const domesticOpenDailyCoverage = await buildDailyTechnicalCoverage({
      market: 'domestic',
      exchange: 'kis',
      marketOpen: true,
      symbols: ['005930'],
      fetchSnapshot: async () => ({
        ok: true,
        source: 'kis_domestic_daily_price',
        providerMode: 'rest',
        price: 71000,
        open: 70000,
        high: 71500,
        low: 69000,
        dailyBars: [
          { open: 69000, high: 70000, low: 68000, close: 69500 },
          { open: 69500, high: 70500, low: 69000, close: 70200 },
          { open: 70200, high: 71500, low: 70000, close: 71000 },
        ],
        stale: false,
      }),
    });
    assert.equal(domesticOpenDailyCoverage.checkedCount, 1);
    assert.equal(domesticOpenDailyCoverage.availableCount, 1);
    assert.equal(domesticOpenDailyCoverage.bullishCount, 1);

    const kisCachePath = path.join(dir, 'kis-daily-cache.json');
    let kisFetchCount = 0;
    const cachedFetchSnapshot = async () => {
      kisFetchCount += 1;
      return {
        ok: true,
        source: 'kis_domestic_daily_price',
        providerMode: 'rest',
        price: 71000,
        open: 70000,
        dailyBars: [
          { open: 69000, high: 70000, low: 68000, close: 69500 },
          { open: 69500, high: 70500, low: 69000, close: 70200 },
          { open: 70200, high: 71500, low: 70000, close: 71000 },
        ],
      };
    };
    const firstKisCachedCoverage = await buildDailyTechnicalCoverage({
      market: 'domestic',
      exchange: 'kis',
      symbols: ['005930'],
      fetchSnapshot: cachedFetchSnapshot,
      cachePath: kisCachePath,
      cacheMinutes: 60,
    });
    const secondKisCachedCoverage = await buildDailyTechnicalCoverage({
      market: 'domestic',
      exchange: 'kis',
      symbols: ['005930'],
      fetchSnapshot: cachedFetchSnapshot,
      cachePath: kisCachePath,
      cacheMinutes: 60,
    });
    assert.equal(kisFetchCount, 1, 'KIS daily TA cache should avoid duplicate API calls inside TTL');
    assert.equal(firstKisCachedCoverage.cache.misses, 1);
    assert.equal(secondKisCachedCoverage.cache.hits, 1);
    assert.equal(secondKisCachedCoverage.rows[0].cached, true);

    const cryptoSnapshotCalls = [];
    const cryptoDailyCoverage = await buildDailyTechnicalCoverage({
      market: 'crypto',
      exchange: 'binance',
      marketOpen: true,
      symbols: ['BTC/USDT'],
      fetchSnapshot: async (request) => {
        cryptoSnapshotCalls.push(request);
        return {
          ok: true,
          source: 'tradingview_ws_service',
          providerMode: 'websocket_http_latest',
          symbol: 'BINANCE:BTCUSDT',
          timeframe: '60',
          price: 120,
          open: 118,
          high: 122,
          low: 117,
          dailyBars: Array.from({ length: 30 }, (_, index) => ({
            open: 90 + index,
            high: 92 + index,
            low: 89 + index,
            close: 91 + index,
          })),
          stale: false,
        };
      },
      fetchCryptoDailyFallback: async (fallbackSymbol) => ({
        symbol: fallbackSymbol,
        sourcePolicy: 'tradingview',
        ok: true,
        reason: 'daily_trend_bullish',
        source: 'binance_ohlcv_daily_for_tradingview_guard',
        providerMode: 'binance_ohlcv',
        bars: 90,
        directHttpFallback: 'binance_ohlcv_daily',
      }),
    });
    assert.equal(cryptoDailyCoverage.checkedCount, 1);
    assert.equal(cryptoDailyCoverage.availableCount, 1);
    assert.equal(cryptoDailyCoverage.bullishCount, 1);
    assert.equal(
      cryptoSnapshotCalls.length,
      0,
      'crypto candidate daily coverage should not open TradingView subscriptions by default',
    );

    const previousProvider = process.env.LUNA_DISCOVERY_FUNNEL_CRYPTO_DAILY_TA_PROVIDER;
    process.env.LUNA_DISCOVERY_FUNNEL_CRYPTO_DAILY_TA_PROVIDER = 'tradingview_realtime';
    try {
      await buildDailyTechnicalCoverage({
        market: 'crypto',
        exchange: 'binance',
        marketOpen: true,
        symbols: ['BTC/USDT'],
        fetchSnapshot: async (request) => {
          cryptoSnapshotCalls.push(request);
          return {
            ok: true,
            source: 'tradingview_ws_service',
            providerMode: 'websocket_http_latest',
            symbol: 'BINANCE:BTCUSDT',
            timeframe: '60',
            price: 120,
            open: 118,
            high: 122,
            low: 117,
            dailyBars: Array.from({ length: 30 }, (_, index) => ({
              open: 90 + index,
              high: 92 + index,
              low: 89 + index,
              close: 91 + index,
            })),
            stale: false,
          };
        },
      });
      assert.notEqual(
        String(cryptoSnapshotCalls[0]?.timeframe || '').toUpperCase(),
        'D',
        'optional TradingView crypto coverage should use entry timeframe, not realtime D bars',
      );
    } finally {
      if (previousProvider == null) delete process.env.LUNA_DISCOVERY_FUNNEL_CRYPTO_DAILY_TA_PROVIDER;
      else process.env.LUNA_DISCOVERY_FUNNEL_CRYPTO_DAILY_TA_PROVIDER = previousProvider;
    }

    const cryptoFallbackCoverage = await buildDailyTechnicalCoverage({
      market: 'crypto',
      exchange: 'binance',
      marketOpen: true,
      symbols: ['ONDO/USDT'],
      fetchSnapshot: async () => ({
        ok: false,
        error: 'tradingview_http_latest_empty',
        directHttpFallback: { error: 'tradingview_http_latest_empty' },
      }),
      fetchCryptoDailyFallback: async (fallbackSymbol) => ({
        symbol: fallbackSymbol,
        sourcePolicy: 'tradingview',
        ok: true,
        reason: 'daily_trend_bullish',
        source: 'binance_ohlcv_daily_for_tradingview_guard',
        providerMode: 'binance_ohlcv',
        bars: 90,
        directHttpFallback: 'binance_ohlcv_daily',
      }),
    });
    assert.equal(cryptoFallbackCoverage.availableCount, 1);
    assert.equal(cryptoFallbackCoverage.bullishCount, 1);
    assert.equal(
      cryptoFallbackCoverage.rows[0]?.source,
      'binance_ohlcv_daily_for_tradingview_guard',
      'crypto daily coverage should fall back to Binance OHLCV when TradingView realtime bar is missing for candidate symbols',
    );

    const overseasOpenCoverage = buildRequiredAnalystCoverage({
      market: 'overseas',
      marketOpen: true,
      analysisSymbols: ['NVDA'],
      analysisRows: [
        { symbol: 'NVDA', analyst: 'sentiment', count: 1, latest_created_at: new Date().toISOString() },
        { symbol: 'NVDA', analyst: 'market_flow', count: 1, latest_created_at: new Date().toISOString() },
      ],
    });
    assert.ok(
      overseasOpenCoverage.bottlenecks.includes('technical_analysis_missing_for_candidates'),
      'overseas missing TA should be marked as a live bottleneck when market is open',
    );

    const cryptoCoverage = buildRequiredAnalystCoverage({
      market: 'crypto',
      marketOpen: true,
      analysisSymbols: ['SOL/USDT'],
      analysisRows: [
        { symbol: 'SOL/USDT', analyst: 'ta_mtf', count: 1, latest_created_at: new Date().toISOString() },
        { symbol: 'SOL/USDT', analyst: 'sentiment', count: 1, latest_created_at: new Date().toISOString() },
      ],
    });
    assert.ok(
      cryptoCoverage.bottlenecks.includes('onchain_analysis_missing_for_candidates'),
      'crypto missing onchain should be visible in required analyst coverage',
    );
    const cryptoScopedSymbols = buildRequiredCoverageSymbols({
      market: 'crypto',
      analysisSymbols: ['SAHARA/USDT', 'PLUME/USDT'],
      decisionDiagnostics: [],
      dailyTechnicalCoverage: {
        rows: [
          { symbol: 'SAHARA/USDT', ok: true, reason: 'daily_trend_bullish' },
          { symbol: 'PLUME/USDT', ok: false, reason: 'daily_trend_not_bullish' },
        ],
      },
    });
    assert.deepEqual(
      cryptoScopedSymbols,
      [],
      'daily bullish crypto evidence alone should not force sentiment/onchain required coverage',
    );
    const cryptoDecisionScopedSymbols = buildRequiredCoverageSymbols({
      market: 'crypto',
      analysisSymbols: ['SAHARA/USDT', 'PLUME/USDT'],
      decisionDiagnostics: [{ symbol: 'SAHARA/USDT', actionability: 'relaxed_probe_candidate' }],
      dailyTechnicalCoverage: null,
    });
    assert.deepEqual(
      cryptoDecisionScopedSymbols,
      ['SAHARA/USDT'],
      'crypto required analyst coverage should scope to entry-targetable candidates',
    );
    const cryptoScopedCoverage = buildRequiredAnalystCoverage({
      market: 'crypto',
      marketOpen: true,
      analysisSymbols: ['SAHARA/USDT', 'PLUME/USDT'],
      requiredSymbols: cryptoDecisionScopedSymbols,
      analysisRows: [
        { symbol: 'SAHARA/USDT', analyst: 'ta_mtf', count: 1, latest_created_at: new Date().toISOString() },
        { symbol: 'SAHARA/USDT', analyst: 'sentiment', count: 1, latest_created_at: new Date().toISOString() },
        { symbol: 'SAHARA/USDT', analyst: 'onchain', count: 1, latest_created_at: new Date().toISOString() },
        { symbol: 'PLUME/USDT', analyst: 'ta_mtf', count: 1, latest_created_at: new Date().toISOString() },
      ],
    });
    assert.equal(
      cryptoScopedCoverage.bottlenecks.includes('sentiment_analysis_partial_for_candidates'),
      false,
      'non-targetable crypto candidates should not create false sentiment partial bottlenecks',
    );
    assert.deepEqual(cryptoScopedCoverage.scope.ignoredSymbols, ['PLUME/USDT']);
    return {
      ok: true,
      smoke: 'luna-discovery-funnel-report',
      status: report.status,
      market: crypto.market,
      candidateCount: crypto.candidateUniverse.activeCount,
      buyCount: crypto.signalPersistence.buyCount,
      activeTriggers: crypto.entryTriggers.activeCount,
    };
  } finally {
    await cleanupFixture(symbol);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const result = await runLunaDiscoveryFunnelReportSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-discovery-funnel-report-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-discovery-funnel-report-smoke 실패:',
  });
}
