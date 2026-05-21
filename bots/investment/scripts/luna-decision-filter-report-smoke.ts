#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { ensureCandidateUniverseTable } from '../team/discovery/discovery-store.ts';
import {
  buildNearMissWatchCandidate,
  buildDecisionFilterDiagnostics,
  buildLunaDecisionFilterReport,
  promoteCryptoDailyBullishActiveCandidateProbe,
  promoteStockDailyBullishActiveCandidateProbe,
} from './runtime-luna-decision-filter-report.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

const now = new Date().toISOString();

function row(symbol, analyst, signal, confidence) {
  return {
    symbol,
    analyst,
    signal,
    confidence,
    reasoning: `smoke ${analyst} ${signal}`,
    created_at: now,
  };
}

export async function runLunaDecisionFilterReportSmoke() {
  const rows = [
    row('NEWS/USDT', 'news', 'BUY', 0.9),
    row('NEWS/USDT', 'ta_mtf', 'HOLD', 0.62),
    row('NEWS/USDT', 'onchain', 'HOLD', 0.6),
    row('NEWS/USDT', 'sentiment', 'HOLD', 0.55),
    row('READY/USDT', 'news', 'BUY', 0.82),
    row('READY/USDT', 'ta_mtf', 'BUY', 0.8),
    row('READY/USDT', 'onchain', 'BUY', 0.76),
    row('READY/USDT', 'sentiment', 'BUY', 0.74),
    row('LOW/USDT', 'news', 'BUY', 0.51),
    row('LOW/USDT', 'ta_mtf', 'BUY', 0.52),
    row('LOW/USDT', 'onchain', 'BUY', 0.53),
    row('LOW/USDT', 'sentiment', 'BUY', 0.51),
    row('WATCH/USDT', 'news', 'HOLD', 0.62),
    row('WATCH/USDT', 'ta_mtf', 'BUY', 0.78),
    row('WATCH/USDT', 'onchain', 'HOLD', 0.66),
    row('WATCH/USDT', 'sentiment', 'BUY', 0.73),
  ];

  const diagnostics = buildDecisionFilterDiagnostics(rows, {
    exchange: 'binance',
    minConfidence: 0.7,
    env: { LUNA_CONSERVATIVE_RELAXATION_ENABLED: 'false' },
  });
  const bySymbol = Object.fromEntries(diagnostics.map((item) => [item.symbol, item]));

  assert.equal(bySymbol['READY/USDT'].actionability, 'likely_actionable');
  assert.equal(bySymbol['NEWS/USDT'].actionability, 'filtered_before_signal');
  assert.ok(bySymbol['NEWS/USDT'].reasons.includes('news_only_buy'));
  assert.ok(bySymbol['NEWS/USDT'].reasons.includes('technical_not_confirmed'));
  assert.ok(bySymbol['NEWS/USDT'].reasons.includes('onchain_not_confirmed'));
  assert.equal(bySymbol['LOW/USDT'].actionability, 'filtered_before_signal');
  assert.ok(bySymbol['LOW/USDT'].reasons.includes('average_confidence_below_min'));
  const watchCandidate = buildNearMissWatchCandidate(bySymbol['WATCH/USDT']);
  assert.equal(watchCandidate.readiness, 'near_miss_watch');
  assert.equal(watchCandidate.watchReason, 'technical_buy_waiting_fusion_quality');
  assert.equal(watchCandidate.missingConfirmations.includes('onchain'), false);
  assert.ok(watchCandidate.missingConfirmations.includes('confidence'));

  const domesticNearMiss = buildNearMissWatchCandidate({
    symbol: '005380',
    exchange: 'kis',
    actionability: 'filtered_before_signal',
    recommendation: 'wait_for_market_flow_confirmation',
    reasons: ['market_flow_not_confirmed'],
    minConfidence: 0.18,
    fused: { recommendation: 'LONG', fusedScore: 0.2071, averageConfidence: 0.3799, hasConflict: false },
    analystSummary: {
      byAnalyst: {
        ta_mtf: { signal: 'BUY', confidence: 0.3 },
        news: { signal: 'BUY', confidence: 0.7 },
        sentiment: { signal: 'HOLD', confidence: 0.3 },
      },
    },
  });
  assert.equal(domesticNearMiss.watchReason, 'technical_buy_waiting_fusion_quality');
  assert.deepEqual(domesticNearMiss.missingConfirmations, ['market_flow']);

  const domesticNeutralSentimentRows = [
    row('005380', 'news', 'BUY', 0.8),
    row('005380', 'ta_mtf', 'BUY', 0.55),
    row('005380', 'market_flow', 'BUY', 0.55),
    row('005380', 'sentiment', 'HOLD', 0.4),
  ];
  const domesticNeutral = buildDecisionFilterDiagnostics(domesticNeutralSentimentRows, {
    exchange: 'kis',
    minConfidence: 0.18,
  })[0];
  assert.equal(domesticNeutral.actionability, 'likely_actionable');
  assert.equal(domesticNeutral.reasons.includes('sentiment_not_confirmed'), false);

  const domesticDailyBearishGuard = buildDecisionFilterDiagnostics(domesticNeutralSentimentRows, {
    exchange: 'kis',
    minConfidence: 0.18,
    dailyTechnicalBySymbol: {
      '005380': {
        ok: false,
        reason: 'kis_daily_trend_not_bullish',
        source: 'kis_domestic_daily_price',
        providerMode: 'websocket',
        cachedAt: now,
      },
    },
  })[0];
  assert.equal(domesticDailyBearishGuard.actionability, 'filtered_before_signal');
  assert.equal(domesticDailyBearishGuard.recommendation, 'wait_for_daily_technical_confirmation');
  assert.equal(domesticDailyBearishGuard.reasons.includes('daily_technical_not_confirmed'), true);
  const domesticDailyBearishWatch = buildNearMissWatchCandidate(domesticDailyBearishGuard);
  assert.equal(domesticDailyBearishWatch.watchReason, 'stock_daily_technical_not_confirmed');
  assert.equal(domesticDailyBearishWatch.nextAction, 'wait_for_daily_technical_confirmation_before_signal_persistence');
  assert.equal(domesticDailyBearishWatch.dailyTechnical.reason, 'kis_daily_trend_not_bullish');

  const domesticDailyTechnicalPresignal = buildDecisionFilterDiagnostics([
    row('000500', 'market_flow', 'BUY', 0.55),
  ], {
    exchange: 'kis',
    minConfidence: 0.18,
    dailyTechnicalBySymbol: {
      '000500': {
        ok: true,
        reason: 'kis_daily_chart_bullish',
        source: 'kis_domestic_daily_price',
        providerMode: 'rest',
        cachedAt: now,
      },
    },
  })[0];
  assert.equal(domesticDailyTechnicalPresignal.actionability, 'likely_actionable');
  assert.equal(domesticDailyTechnicalPresignal.reasons.includes('insufficient_analyst_coverage'), false);
  assert.equal(domesticDailyTechnicalPresignal.reasons.includes('technical_not_confirmed'), false);
  assert.equal(domesticDailyTechnicalPresignal.reasons.includes('sentiment_not_confirmed'), false);
  assert.equal(domesticDailyTechnicalPresignal.analystSummary.byAnalyst.ta_mtf.signal, 'BUY');
  assert.equal(domesticDailyTechnicalPresignal.dailyTechnical.reason, 'kis_daily_chart_bullish');

  const stockLightModeWithoutSentiment = buildDecisionFilterDiagnostics([
    row('INOD', 'market_flow', 'BUY', 0.31),
  ], {
    exchange: 'kis_overseas',
    minConfidence: 0.18,
    dailyTechnicalBySymbol: {
      INOD: {
        ok: true,
        reason: 'kis_daily_chart_bullish',
        source: 'kis_overseas_daily_price',
        providerMode: 'rest',
        cachedAt: now,
      },
    },
    env: { LUNA_STOCK_INTRADAY_ENRICHMENT_ENABLED: 'false' },
  })[0];
  assert.equal(stockLightModeWithoutSentiment.actionability, 'filtered_before_signal');
  assert.equal(stockLightModeWithoutSentiment.reasons.includes('sentiment_not_confirmed'), false);
  assert.equal(stockLightModeWithoutSentiment.reasons.includes('market_flow_not_confirmed'), true);

  const relaxedStock = buildDecisionFilterDiagnostics([
    row('005930', 'news', 'BUY', 0.9),
    row('005930', 'ta_mtf', 'HOLD', 0.72),
    row('005930', 'market_flow', 'HOLD', 0.68),
    row('005930', 'sentiment', 'HOLD', 0.66),
  ], {
    exchange: 'kis',
    minConfidence: 0.7,
    env: { LUNA_CONSERVATIVE_RELAXATION_ENABLED: 'true' },
  })[0];
  assert.equal(relaxedStock.actionability, 'relaxed_probe_candidate');
  assert.equal(relaxedStock.relaxation.reason, 'stock_relaxed_narrative_probe');
  const relaxedWatch = buildNearMissWatchCandidate(relaxedStock);
  assert.equal(relaxedWatch.readiness, 'relaxed_probe_watch');

  const relaxedCrypto = buildDecisionFilterDiagnostics([
    row('NIL/USDT', 'sentiment', 'BUY', 0.86),
    row('NIL/USDT', 'news', 'BUY', 0.84),
    row('NIL/USDT', 'ta_mtf', 'HOLD', 0.7),
    row('NIL/USDT', 'onchain', 'HOLD', 0.7),
  ], {
    exchange: 'binance',
    minConfidence: 0.7,
    env: { LUNA_CONSERVATIVE_RELAXATION_ENABLED: 'true' },
  })[0];
  assert.equal(relaxedCrypto.actionability, 'relaxed_probe_candidate');
  assert.equal(relaxedCrypto.relaxation.reason, 'crypto_relaxed_narrative_probe');

  const relaxedCryptoMtf = buildDecisionFilterDiagnostics([
    {
      ...row('NOT/USDT', 'ta_mtf', 'BUY', 0.19),
      reasoning: '15분봉=BUY(40%) | 1시간봉=BUY(40%) | 4시간봉=HOLD(10%) | 일봉=SELL(10%); 가중점수 0.95; 추세보정 +0.28',
    },
    row('NOT/USDT', 'onchain', 'HOLD', 0.49),
    row('NOT/USDT', 'sentiment', 'HOLD', 0.45),
    row('NOT/USDT', 'news', 'HOLD', 0.35),
  ], {
    exchange: 'binance',
    minConfidence: 0.7,
    env: { LUNA_CONSERVATIVE_RELAXATION_ENABLED: 'true' },
  })[0];
  assert.equal(relaxedCryptoMtf.actionability, 'relaxed_probe_candidate');
  assert.equal(relaxedCryptoMtf.relaxation.reason, 'crypto_relaxed_mtf_momentum_probe');
  assert.equal(relaxedCryptoMtf.relaxation.momentumEvidence.intradayBuyFrames, 2);

  const cryptoMtfHoldPresignal = buildDecisionFilterDiagnostics([
    {
      ...row('UTK/USDT', 'ta_mtf', 'HOLD', 0.28),
      reasoning: '15분봉=HOLD(10%) | 1시간봉=HOLD(15%) | 4시간봉=BUY(38%) | 일봉=HOLD(12%); 가중점수 0.85',
    },
    row('UTK/USDT', 'onchain', 'HOLD', 0.3),
    row('UTK/USDT', 'sentiment', 'HOLD', 0.4),
  ], {
    exchange: 'binance',
    minConfidence: 0.7,
    env: { LUNA_CONSERVATIVE_RELAXATION_ENABLED: 'false' },
  })[0];
  assert.equal(cryptoMtfHoldPresignal.actionability, 'filtered_before_signal');
  assert.equal(cryptoMtfHoldPresignal.reasons.includes('technical_not_confirmed'), false);
  assert.equal(cryptoMtfHoldPresignal.reasons.includes('onchain_not_confirmed'), true);
  assert.equal(cryptoMtfHoldPresignal.reasons.includes('sentiment_not_confirmed'), true);

  const dailyBullishProbeInput = {
    symbol: 'SAHARA/USDT',
    exchange: 'binance',
    actionability: 'filtered_before_signal',
    recommendation: 'wait_for_trend_confirmation',
    reasons: [
      'insufficient_analyst_coverage',
      'fusion_not_long',
      'average_confidence_below_min',
      'technical_not_confirmed',
      'onchain_not_confirmed',
      'sentiment_not_confirmed',
    ],
    minConfidence: 0.35,
    fused: { recommendation: 'HOLD', fusedScore: 0, averageConfidence: 0.11, hasConflict: false },
    analystSummary: {
      byAnalyst: {
        ta_mtf: { signal: 'HOLD', confidence: 0.22 },
      },
    },
    activeCandidate: { rank: 1, score: 0.84, confidence: 0.8 },
    dailyTechnical: { ok: true, reason: 'daily_trend_bullish', source: 'binance_ohlcv_daily_for_tradingview_guard' },
  };
  const dailyBullishProbe = buildNearMissWatchCandidate(dailyBullishProbeInput);
  assert.equal(dailyBullishProbe.readiness, 'relaxed_probe_watch');
  assert.equal(dailyBullishProbe.watchReason, 'daily_bullish_active_candidate_probe');
  assert.equal(dailyBullishProbe.nextAction, 'run_l13_probe_with_existing_risk_and_entry_guards');
  assert.ok(dailyBullishProbe.missingConfirmations.includes('intraday_technical'));

  const promotedCryptoDailyBullishProbe = promoteCryptoDailyBullishActiveCandidateProbe({
    ...dailyBullishProbeInput,
    fused: { recommendation: 'HOLD', fusedScore: 0.01, averageConfidence: 0.28, hasConflict: false },
  });
  assert.equal(promotedCryptoDailyBullishProbe.actionability, 'relaxed_probe_candidate');
  assert.equal(promotedCryptoDailyBullishProbe.relaxation.reason, 'crypto_daily_bullish_active_candidate_probe');
  assert.equal(promotedCryptoDailyBullishProbe.relaxation.sizeRatio, 0.25);

  const dailyBullishWithExistingEvidence = buildNearMissWatchCandidate({
    ...dailyBullishProbeInput,
    analystSummary: {
      byAnalyst: {
        ta_mtf: { signal: 'HOLD', confidence: 0.22 },
        onchain: { signal: 'HOLD', confidence: 0.3 },
        sentiment: { signal: 'HOLD', confidence: 0.4 },
      },
    },
  });
  assert.equal(dailyBullishWithExistingEvidence.missingConfirmations.includes('onchain'), false);
  assert.equal(dailyBullishWithExistingEvidence.missingConfirmations.includes('sentiment'), false);

  const weakIntradayDailyBullish = buildNearMissWatchCandidate({
    ...dailyBullishProbeInput,
    analystSummary: {
      byAnalyst: {
        ta_mtf: { signal: 'HOLD', confidence: 0.12 },
      },
    },
  });
  assert.equal(weakIntradayDailyBullish, null);

  const overseasDailyBullishWatch = buildNearMissWatchCandidate({
    symbol: 'NVDA',
    exchange: 'kis_overseas',
    actionability: 'filtered_before_signal',
    recommendation: 'wait_for_market_flow_confirmation',
    reasons: ['market_flow_not_confirmed'],
    minConfidence: 0.18,
    fused: { recommendation: 'LONG', fusedScore: 0.2054, averageConfidence: 0.235, hasConflict: false },
    analystSummary: {
      byAnalyst: {
        market_flow: { signal: 'HOLD', confidence: 0.12 },
        ta_mtf: { signal: 'BUY', confidence: 0.35 },
      },
    },
    activeCandidate: { rank: 1, score: 0.84, confidence: 0.81 },
    dailyTechnical: { ok: true, reason: 'kis_daily_chart_bullish', source: 'kis_overseas_daily_price' },
  });
  assert.equal(overseasDailyBullishWatch.readiness, 'relaxed_probe_watch');
  assert.equal(overseasDailyBullishWatch.watchReason, 'stock_daily_bullish_active_candidate_probe');
  assert.deepEqual(overseasDailyBullishWatch.missingConfirmations, ['market_flow']);
  assert.equal(overseasDailyBullishWatch.nextAction, 'refresh_market_flow_then_l13_probe_with_existing_guards');

  const promotedOverseasDailyBullish = promoteStockDailyBullishActiveCandidateProbe({
    symbol: 'NVDA',
    exchange: 'kis_overseas',
    actionability: 'filtered_before_signal',
    recommendation: 'wait_for_market_flow_confirmation',
    reasons: ['market_flow_not_confirmed', 'fusion_not_long'],
    minConfidence: 0.18,
    fused: { recommendation: 'HOLD', fusedScore: -0.02, averageConfidence: 0.235, hasConflict: false },
    analystSummary: {
      byAnalyst: {
        market_flow: { signal: 'HOLD', confidence: 0.12 },
        ta_mtf: { signal: 'BUY', confidence: 0.35 },
      },
    },
    activeCandidate: { rank: 1, score: 0.84, confidence: 0.81 },
    dailyTechnical: { ok: true, reason: 'kis_daily_chart_bullish', source: 'kis_overseas_daily_price' },
  });
  assert.equal(promotedOverseasDailyBullish.actionability, 'relaxed_probe_candidate');
  assert.equal(promotedOverseasDailyBullish.relaxation.reason, 'stock_daily_bullish_active_candidate_probe');
  const promotedOverseasWatch = buildNearMissWatchCandidate(promotedOverseasDailyBullish);
  assert.equal(promotedOverseasWatch.nextAction, 'run_l13_probe_with_existing_risk_and_entry_guards');
  assert.deepEqual(promotedOverseasWatch.missingConfirmations, ['market_flow', 'fusion']);

  const fixtureSymbol = `DFILTER${Date.now()}/USDT`;
  const openFixtureSymbol = `DFILTEROPEN${Date.now()}/USDT`;
  const missingAnalysisFixtureSymbol = `DFILTERMISS${Date.now()}/USDT`;
  const smokeBinanceTopVolumeUniverse = {
    source: 'smoke_binance_top30_universe',
    fetchedAt: now,
    quote: 'USDT',
    limit: 30,
    symbols: [fixtureSymbol, openFixtureSymbol, missingAnalysisFixtureSymbol],
    ranks: {
      [fixtureSymbol]: 1,
      [openFixtureSymbol]: 2,
      [missingAnalysisFixtureSymbol]: 3,
    },
    rows: [
      { symbol: fixtureSymbol, quoteVolume: 30_000_000 },
      { symbol: openFixtureSymbol, quoteVolume: 29_000_000 },
      { symbol: missingAnalysisFixtureSymbol, quoteVolume: 28_000_000 },
    ],
    excluded: {},
  };
  await db.initSchema();
  await ensureCandidateUniverseTable();
  try {
    await db.run(
      `INSERT INTO candidate_universe
         (symbol, market, source, source_tier, score, confidence, reason, reason_code, ttl_hours, raw_data, expires_at)
       VALUES
         ($1, 'crypto', 'binance_market_momentum', 1, 0.91, 0.88, 'decision filter smoke', 'decision_filter_smoke', 2, '{}'::jsonb, now() + interval '2 hours')
       ON CONFLICT (symbol, market, source) DO UPDATE SET
         score = excluded.score,
         confidence = excluded.confidence,
         discovered_at = now(),
         expires_at = now() + interval '2 hours'`,
      [fixtureSymbol],
    );
    await db.run(
      `INSERT INTO candidate_universe
         (symbol, market, source, source_tier, score, confidence, reason, reason_code, ttl_hours, raw_data, expires_at)
       VALUES
         ($1, 'crypto', 'binance_market_momentum', 1, 0.93, 0.90, 'decision filter open smoke', 'decision_filter_open_smoke', 2, '{}'::jsonb, now() + interval '2 hours')
       ON CONFLICT (symbol, market, source) DO UPDATE SET
         score = excluded.score,
         confidence = excluded.confidence,
         discovered_at = now(),
         expires_at = now() + interval '2 hours'`,
      [openFixtureSymbol],
    );
    await db.run(
      `INSERT INTO candidate_universe
         (symbol, market, source, source_tier, score, confidence, reason, reason_code, ttl_hours, raw_data, expires_at)
       VALUES
         ($1, 'crypto', 'binance_market_momentum', 1, 0.89, 0.82, 'decision filter missing analysis smoke', 'decision_filter_missing_analysis_smoke', 2, '{}'::jsonb, now() + interval '2 hours')
       ON CONFLICT (symbol, market, source) DO UPDATE SET
         score = excluded.score,
         confidence = excluded.confidence,
         discovered_at = now(),
         expires_at = now() + interval '2 hours'`,
      [missingAnalysisFixtureSymbol],
    );
    await db.insertAnalysis({
      symbol: fixtureSymbol,
      analyst: 'ta_mtf',
      signal: 'BUY',
      confidence: 0.81,
      reasoning: 'decision filter smoke technical',
      metadata: { smoke: true },
      exchange: 'binance',
    });
    await db.insertAnalysis({
      symbol: openFixtureSymbol,
      analyst: 'ta_mtf',
      signal: 'BUY',
      confidence: 0.91,
      reasoning: 'decision filter open position smoke',
      metadata: { smoke: true },
      exchange: 'binance',
    });
    const activeReport = await buildLunaDecisionFilterReport({
      exchange: 'binance',
      market: 'crypto',
      activeCandidates: true,
      openPositionSymbols: [openFixtureSymbol],
      hours: 1,
      limit: 20,
      binanceTopVolumeUniverse: smokeBinanceTopVolumeUniverse,
    });
    assert.equal(activeReport.symbolScope, 'active_candidates');
    assert.ok(activeReport.activeCandidateSymbols.includes(fixtureSymbol));
    assert.equal(activeReport.activeCandidateSymbols.includes(openFixtureSymbol), false);
    assert.ok(activeReport.excludedOpenPositionSymbols.includes(openFixtureSymbol));
    assert.ok(activeReport.activeCandidateSymbols.length <= 20);
    assert.ok(Array.isArray(activeReport.nearMissWatchlist));
    assert.equal(activeReport.bottlenecks.includes('active_candidate_analysis_missing'), true);
    assert.ok(Number(activeReport.activeCandidateCoverage?.missing || 0) >= 1);

    const overseasReport = await buildLunaDecisionFilterReport({
      market: 'overseas',
      symbols: ['NVDA'],
      hours: 1,
      limit: 1,
    });
    assert.equal(overseasReport.exchange, 'kis_overseas');
  } finally {
    await db.run(`DELETE FROM analysis WHERE symbol = $1 AND metadata->>'smoke' = 'true'`, [fixtureSymbol]).catch(() => null);
    await db.run(`DELETE FROM analysis WHERE symbol = $1 AND metadata->>'smoke' = 'true'`, [openFixtureSymbol]).catch(() => null);
    await db.run(`DELETE FROM candidate_universe WHERE symbol = $1 AND source = 'binance_market_momentum'`, [fixtureSymbol]).catch(() => null);
    await db.run(`DELETE FROM candidate_universe WHERE symbol = $1 AND source = 'binance_market_momentum'`, [openFixtureSymbol]).catch(() => null);
    await db.run(`DELETE FROM candidate_universe WHERE symbol = $1 AND source = 'binance_market_momentum'`, [missingAnalysisFixtureSymbol]).catch(() => null);
  }

  return {
    ok: true,
    smoke: 'luna-decision-filter-report',
    checked: diagnostics.length,
    newsOnlyReasons: bySymbol['NEWS/USDT'].reasons,
    readyActionability: bySymbol['READY/USDT'].actionability,
  };
}

async function main() {
  const result = await runLunaDecisionFilterReportSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-decision-filter-report-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-decision-filter-report-smoke 실패:',
  });
}
