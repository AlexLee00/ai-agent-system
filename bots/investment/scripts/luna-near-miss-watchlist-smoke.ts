#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  buildLunaNearMissWatchlist,
  defaultNearMissWatchlistOutputPath,
  runLunaNearMissWatchlist,
} from './runtime-luna-near-miss-watchlist.ts';

function fixtureReport() {
  return {
    ok: true,
    status: 'luna_decision_filter_attention',
    activeCandidateCoverage: { total: 2, checked: 2, missing: 0 },
    likelyActionableCount: 0,
    filteredCount: 2,
    reasonCounts: { onchain_not_confirmed: 1, fusion_not_long: 1 },
    bottlenecks: ['active_candidates_filtered_before_signal'],
    nearMissWatchlist: [
      {
        symbol: 'HMSTR/USDT',
        exchange: 'binance',
        readiness: 'near_miss_watch',
        watchReason: 'technical_and_sentiment_buy_waiting_onchain',
        missingConfirmations: ['onchain', 'fusion'],
        nextAction: 'refresh_onchain_and_keep_tradingview_daily_guard',
      },
    ],
  };
}

function dailyBullishFallbackReport() {
  return {
    ok: true,
    status: 'luna_decision_filter_attention',
    activeCandidateCoverage: { total: 1, checked: 1, missing: 0 },
    likelyActionableCount: 0,
    filteredCount: 1,
    reasonCounts: { technical_not_confirmed: 1, onchain_not_confirmed: 1, sentiment_not_confirmed: 1 },
    bottlenecks: ['active_candidates_filtered_before_signal'],
    nearMissWatchlist: [],
    top: [
      {
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
        analystSummary: { byAnalyst: { ta_mtf: { signal: 'HOLD', confidence: 0.22 } } },
        activeCandidate: { rank: 1, score: 0.84, confidence: 0.8 },
      },
    ],
  };
}

export async function runLunaNearMissWatchlistSmoke() {
  const built = await buildLunaNearMissWatchlist({
    reportBuilder: async () => fixtureReport(),
  });
  assert.equal(built.status, 'near_miss_watchlist_attention');
  assert.equal(built.summary.count, 1);
  assert.equal(built.summary.byMissingConfirmation.onchain, 1);
  assert.equal(built.watchlist[0].symbol, 'HMSTR/USDT');

  const dailyBullish = await buildLunaNearMissWatchlist({
    market: 'crypto',
    exchange: 'binance',
    reportBuilder: async () => dailyBullishFallbackReport(),
    dailyTechnicalCoverageBuilder: async ({ symbols }) => ({
      enabled: true,
      sourcePolicy: 'tradingview',
      checkedCount: symbols.length,
      availableCount: symbols.length,
      bullishCount: symbols.length,
      rows: symbols.map((symbol) => ({
        symbol,
        ok: true,
        reason: 'daily_trend_bullish',
        source: 'binance_ohlcv_daily_for_tradingview_guard',
      })),
    }),
  });
  assert.equal(dailyBullish.status, 'near_miss_watchlist_attention');
  assert.equal(dailyBullish.watchlist[0].readiness, 'relaxed_probe_watch');
  assert.equal(dailyBullish.watchlist[0].watchReason, 'daily_bullish_active_candidate_probe');
  assert.equal(dailyBullish.evidence.dailyTechnicalCoverage.bullishCount, 1);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'luna-near-miss-watchlist-smoke-'));
  const outputPath = path.join(tmp, 'watchlist.json');
  const blocked = await runLunaNearMissWatchlist({
    apply: true,
    confirm: null,
    outputPath,
    reportBuilder: async () => fixtureReport(),
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 'near_miss_watchlist_confirm_required');
  assert.equal(fs.existsSync(outputPath), false);

  const applied = await runLunaNearMissWatchlist({
    apply: true,
    confirm: 'luna-near-miss-watchlist',
    outputPath,
    reportBuilder: async () => fixtureReport(),
  });
  assert.equal(applied.ok, true);
  assert.equal(applied.applied, true);
  const written = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.equal(written.summary.count, 1);
  assert.equal(written.watchlist[0].readiness, 'near_miss_watch');
  assert.match(defaultNearMissWatchlistOutputPath('domestic'), /luna-near-miss-watchlist-domestic\.json$/);
  assert.match(defaultNearMissWatchlistOutputPath('crypto'), /luna-near-miss-watchlist-crypto\.json$/);

  return {
    ok: true,
    smoke: 'luna-near-miss-watchlist',
    watchCount: written.summary.count,
    outputWritten: fs.existsSync(outputPath),
  };
}

async function main() {
  const result = await runLunaNearMissWatchlistSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-near-miss-watchlist-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-near-miss-watchlist-smoke 실패:',
  });
}
