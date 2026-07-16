#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import {
  buildReplayCandidate,
  buildUniverseGroups,
  classifyHistoricalRows,
  finalizeCoveredUniverseGroups,
  filterEligibleBinanceTickerRows,
  findClosedDailyIndex,
  findForwardDailyIndex,
  futureNetPct,
  normalizeKlineRows,
  resolveClosedKlineCutoffs,
  summarizeEntryRows,
  summarizeReplay,
} from './luna-crypto-major-universe-simulation.ts';

function rawKline(openTime, close, volume = 100) {
  return [
    openTime,
    String(close * 0.99),
    String(close * 1.01),
    String(close * 0.98),
    String(close),
    String(volume),
    openTime + 3_599_999,
    '0',
    10,
    '0',
    '0',
    '0',
  ];
}

async function main() {
  const hour = 60 * 60 * 1000;
  const normalized = normalizeKlineRows([
    rawKline(0, 100),
    rawKline(hour, 103, 220),
  ], { interval: '1h', symbol: 'BTCUSDT' });
  assert.equal(normalized.rows.length, 2);
  assert.equal(normalized.rawShapeValid, true);
  assert.equal(normalized.rows[1].close, 103);
  assert.equal(normalized.outliers.length, 0);
  assert.throws(
    () => normalizeKlineRows([[0, '1']], { interval: '1h', symbol: 'BROKENUSDT' }),
    /kline_raw_shape_invalid/,
  );
  const cutoffs = resolveClosedKlineCutoffs(Date.parse('2026-07-16T12:34:56.000Z'));
  assert.equal(new Date(cutoffs.hourlyEndTime).toISOString(), '2026-07-16T11:59:59.999Z');
  assert.equal(new Date(cutoffs.dailyEndTime).toISOString(), '2026-07-15T23:59:59.999Z');
  assert.equal(findClosedDailyIndex([
    { openTime: 0, closeTime: 24 * hour - 1 },
    { openTime: 24 * hour, closeTime: 48 * hour - 1 },
  ], 36 * hour), 0);
  const dailyRows = [
    { openTime: 0, closeTime: 24 * hour - 1, close: 100 },
    { openTime: 24 * hour, closeTime: 48 * hour - 1, close: 110 },
    { openTime: 48 * hour, closeTime: 72 * hour - 1, close: 120 },
  ];
  const lateEntryCloseTime = 24 * hour - 1;
  assert.equal(findForwardDailyIndex(dailyRows, lateEntryCloseTime, 1), 1);
  assert.equal(findForwardDailyIndex(dailyRows, lateEntryCloseTime, 2), 2);
  assert.equal(futureNetPct(dailyRows, lateEntryCloseTime, 1, 100, 0), 10);

  const marketRows = [
    { symbol: 'btc', market_cap_rank: 1, market_cap: 1_000 },
    { symbol: 'usdt', market_cap_rank: 2, market_cap: 900 },
    { symbol: 'eth', market_cap_rank: 3, market_cap: 800 },
    { symbol: 'usds', market_cap_rank: 4, market_cap: 750 },
    { symbol: 'paxg', market_cap_rank: 4, market_cap: 700 },
    { symbol: 'bnb', market_cap_rank: 5, market_cap: 600 },
    { symbol: 'sol', market_cap_rank: 6, market_cap: 500 },
  ];
  const groups = buildUniverseGroups({
    topVolumeSymbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'PEPE/USDT', 'PAXG/USDT'],
    marketRows,
    tradableSymbols: new Set(['BTCUSDT', 'ETHUSDT', 'USDSUSDT', 'BNBUSDT', 'SOLUSDT', 'PAXGUSDT']),
    broadLimit: 4,
    strictLimit: 2,
  });
  assert.deepEqual(groups.B, ['BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'SOL/USDT']);
  assert.deepEqual(groups.C, ['BTC/USDT', 'ETH/USDT']);
  assert.deepEqual(groups.D, ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']);
  assert.equal(groups.A.includes('PAXG/USDT'), false);
  assert.equal(groups.B.includes('USDT/USDT'), false);
  assert.equal(groups.B.includes('USDS/USDT'), false);
  const eligibleTickers = filterEligibleBinanceTickerRows([
    { symbol: 'PAXGUSDT' },
    { symbol: 'UUSDT' },
    { symbol: 'BTCUSDT' },
  ], {
    symbols: [
      { symbol: 'PAXGUSDT', baseAsset: 'PAXG' },
      { symbol: 'UUSDT', baseAsset: 'U' },
      { symbol: 'BTCUSDT', baseAsset: 'BTC' },
    ],
  });
  assert.deepEqual(eligibleTickers.map((row) => row.symbol), ['BTCUSDT']);
  const finalized = finalizeCoveredUniverseGroups({
    candidateGroups: {
      A: ['BTC/USDT', 'GRAM/USDT', 'SOL/USDT'],
      B: ['BTC/USDT', 'GRAM/USDT', 'ETH/USDT'],
    },
    dataQuality: [
      { symbol: 'BTC/USDT', hourlyRows: 4_320, dailyRows: 180 },
      { symbol: 'GRAM/USDT', hourlyRows: 341, dailyRows: 14 },
      { symbol: 'ETH/USDT', hourlyRows: 4_320, dailyRows: 180 },
    ],
    broadLimit: 2,
    strictLimit: 1,
    minimumHourlyRows: 3_600,
    minimumDailyRows: 180,
  });
  assert.deepEqual(finalized.groups.B, ['BTC/USDT', 'ETH/USDT']);
  assert.deepEqual(finalized.groups.D, ['BTC/USDT']);
  assert.equal(finalized.coverage.rejected[0].symbol, 'GRAM/USDT');

  const candidate = buildReplayCandidate({
    symbol: 'BTC/USDT',
    close: 101,
    targetPrice: 100,
    hourlyFrame: { signal: 'BUY', confidence: 0.78, volumeBurst: 2.1 },
    dailyFrame: { signal: 'BUY', confidence: 0.74, volumeBurst: 1.2 },
    breakoutRetest: true,
    predictiveScore: 0.7,
  });
  assert.equal(candidate.readiness.ok, true);
  assert.equal(candidate.candidate.triggerType, 'pullback_to_support');
  assert.equal(candidate.candidate.triggerHints.technicalTelemetry.mtfAvailable, true);

  const events = [
    { symbol: 'BTC/USDT', firedAt: '2026-01-01T00:00:00.000Z', d1NetPct: 1, d5NetPct: 2, d20NetPct: 4 },
    { symbol: 'ETH/USDT', firedAt: '2026-01-06T00:00:00.000Z', d1NetPct: -1, d5NetPct: -2, d20NetPct: -3 },
    { symbol: 'SMOKE_TEST/USDT', firedAt: '2026-01-07T00:00:00.000Z', d1NetPct: 99, d5NetPct: 99, d20NetPct: 99 },
  ];
  const replay = summarizeReplay(events, 60);
  assert.equal(replay.fires, 2);
  assert.equal(replay.d5.winRatePct, 50);
  assert.equal(replay.d5.meanPct, 0);
  assert.equal(replay.d5.worstPct, -2);
  assert.equal(replay.frequencyPer30Days, 1);

  const classified = classifyHistoricalRows([
    { symbol: 'BTCUSDT', pnl_percent: 2, pnl_net: 12, status: 'closed' },
    { symbol: 'ETH/USDT', pnl_percent: -1, pnl_net: -4, status: 'closed' },
    { symbol: 'SMOKE_TEST/USDT', pnl_percent: 100, pnl_net: 100, status: 'closed' },
  ], groups, { pnlPctField: 'pnl_percent', pnlAmountField: 'pnl_net' });
  assert.equal(classified.A.count, 2);
  assert.equal(classified.A.winRatePct, 50);
  assert.equal(classified.A.pnlAmountTotal, 8);
  const nullClassified = classifyHistoricalRows([
    { symbol: 'BTCUSDT', pnl_percent: null, pnl_net: null, status: 'closed' },
  ], groups, { pnlPctField: 'pnl_percent', pnlAmountField: 'pnl_net' });
  assert.equal(nullClassified.A.pnlAvailable, 0);
  assert.equal(nullClassified.A.pnlAmountAvailable, 0);
  assert.equal(nullClassified.A.winRatePct, null);
  assert.equal(nullClassified.A.pnlAmountTotal, null);
  const entrySummary = summarizeEntryRows([
    { symbol: 'BTCUSDT', trigger_state: 'expired', trigger_meta: {} },
    { symbol: 'ETHUSDT', trigger_state: 'expired', trigger_meta: { reason: 'live_risk_gate_blocked' } },
  ], groups);
  assert.equal(entrySummary.A.guardBlocked, 1);
  assert.equal(entrySummary.A.guardBlockRatePct, 50);
  assert.equal(entrySummary.A.expired, 2);

  return {
    ok: true,
    smoke: 'luna-crypto-major-universe-simulation',
    boundaries: {
      rawKlineShape: true,
      stableGoldExclusion: true,
      entryDecisionReuse: true,
      smokeExclusion: true,
      unitAndOutcomeSummary: true,
      closedCandleNoLookahead: true,
    },
  };
}

const result = await main();
if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
else console.log(`[luna-crypto-major-universe-simulation-smoke] ok ${JSON.stringify(result.boundaries)}`);
