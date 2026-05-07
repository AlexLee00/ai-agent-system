#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import * as db from '../shared/db.ts';
import { ensureCandidateUniverseTable } from '../team/discovery/discovery-store.ts';
import {
  buildNearMissWatchCandidate,
  buildDecisionFilterDiagnostics,
  buildLunaDecisionFilterReport,
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
  assert.equal(watchCandidate.watchReason, 'technical_and_sentiment_buy_waiting_onchain');
  assert.ok(watchCandidate.missingConfirmations.includes('onchain'));

  const fixtureSymbol = `DFILTER${Date.now()}/USDT`;
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
    await db.insertAnalysis({
      symbol: fixtureSymbol,
      analyst: 'ta_mtf',
      signal: 'BUY',
      confidence: 0.81,
      reasoning: 'decision filter smoke technical',
      metadata: { smoke: true },
      exchange: 'binance',
    });
    const activeReport = await buildLunaDecisionFilterReport({
      exchange: 'binance',
      market: 'crypto',
      activeCandidates: true,
      hours: 1,
      limit: 20,
    });
    assert.equal(activeReport.symbolScope, 'active_candidates');
    assert.ok(activeReport.activeCandidateSymbols.includes(fixtureSymbol));
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
    await db.run(`DELETE FROM candidate_universe WHERE symbol = $1 AND source = 'binance_market_momentum'`, [fixtureSymbol]).catch(() => null);
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
