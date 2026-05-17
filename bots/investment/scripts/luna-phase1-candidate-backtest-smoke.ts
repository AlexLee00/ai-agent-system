#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { get } from '../shared/db/core.ts';
import { __test as candidateBacktestTest, runCandidateBacktestRefresh } from './runtime-luna-candidate-backtest-refresh.ts';

async function safeCount(tableName: string) {
  const row = await get(`SELECT count(*)::int AS count FROM ${tableName}`).catch(() => null);
  return row?.count ?? null;
}

const beforeStatus = await safeCount('candidate_backtest_status');
const beforeAudit = await safeCount('predictive_validation_log');

const result = await runCandidateBacktestRefresh({
  json: true,
  dryRun: true,
  fixture: true,
  periods: '30,90',
  limit: 10,
});

const afterStatus = await safeCount('candidate_backtest_status');
const afterAudit = await safeCount('predictive_validation_log');

assert.equal(result.ok, true);
assert.equal(result.dryRun, true);
assert.equal(result.fixture, true);
assert.equal(result.writeMode, 'dry-run');
assert.equal(result.total, 2);
assert.ok(result.passed >= 1, 'fixture must include at least one passing candidate');
assert.ok(result.wouldBlocked >= 1, 'fixture must include at least one would-block candidate');
if (beforeStatus != null && afterStatus != null) assert.equal(afterStatus, beforeStatus, 'dry-run must not write candidate status rows');
if (beforeAudit != null && afterAudit != null) assert.equal(afterAudit, beforeAudit, 'dry-run must not write predictive audit rows');

const negative = result.results.find((item) => item.symbol === 'NEG/USDT');
assert.ok(negative?.wouldBlock, 'negative fixture should be a would-block result');
assert.ok(negative?.reasons?.length > 0, 'would-block fixture should explain reasons');

const syntheticOhlcv = Array.from({ length: 80 }, (_, index) => {
  const close = 100 + index * 0.25 + Math.sin(index / 5) * 1.5;
  return [Date.now() - (80 - index) * 3600_000, close - 0.5, close + 0.8, close - 0.9, close, 1000 + index];
});
const fallbackRows = candidateBacktestTest.buildOhlcvMomentumBacktestRows(syntheticOhlcv, 30, 'crypto');
assert.equal(candidateBacktestTest.rowsHaveUsableTrades(fallbackRows), true, 'OHLCV fallback should produce usable trade rows for trending candles');
const fallbackQuality = candidateBacktestTest.evaluateQuality(fallbackRows);
assert.equal(fallbackQuality.fresh ?? true, true, 'usable OHLCV fallback should be considered fresh');
assert.equal(fallbackQuality.qualityRowSelection, 'best_per_walk_forward_period', 'quality gate should use period representatives');

const drawdownOnlyQuality = candidateBacktestTest.evaluateQuality([
  { status: 'ok', total_trades: 8, sharpe_ratio: 1.4, max_drawdown: 42, win_rate: 62 },
]);
assert.equal(drawdownOnlyQuality.wouldBlock, true, 'drawdown-only violation must would-block');
assert.equal(drawdownOnlyQuality.gateStatus, 'would_block_unhealthy', 'drawdown-only violation should not pass gate');
assert.equal(drawdownOnlyQuality.healthy, false, 'drawdown-only violation should be unhealthy');

const unrealisticSharpeQuality = candidateBacktestTest.evaluateQuality([
  { status: 'ok', total_trades: 4, sharpe_ratio: 25, max_drawdown: 4, win_rate: 75 },
]);
assert.equal(unrealisticSharpeQuality.wouldBlock, true, 'unrealistic sharpe must would-block');
assert.equal(unrealisticSharpeQuality.gateStatus, 'would_block_unstable_backtest', 'unrealistic sharpe should route to stabilization before strategy repair');
assert.equal(unrealisticSharpeQuality.sharpe, 8, 'stored sharpe should be capped for promotion sanity');
assert.ok(unrealisticSharpeQuality.reasons.some((reason) => reason.startsWith('unrealistic_sharpe')), 'unrealistic sharpe reason should be explicit');
assert.ok(unrealisticSharpeQuality.reasons.some((reason) => reason.startsWith('backtest_unstable_sample')), 'unstable sample reason should be explicit');

const periodRepresentativeQuality = candidateBacktestTest.evaluateQuality([
  { status: 'ok', walk_forward_days: 30, total_trades: 40, sharpe_ratio: 1.4, robust_score: 1.2, max_drawdown: 10, win_rate: 55 },
  { status: 'ok', walk_forward_days: 30, total_trades: 45, sharpe_ratio: -9.2, robust_score: -9.2, max_drawdown: 80, win_rate: 8 },
  { status: 'ok', walk_forward_days: 90, total_trades: 35, sharpe_ratio: 0.8, robust_score: 0.6, max_drawdown: 14, win_rate: 48 },
]);
assert.equal(periodRepresentativeQuality.gateStatus, 'pass', 'bad non-representative grid rows must not dominate candidate quality');
assert.equal(periodRepresentativeQuality.qualityRows.length, 2, 'one representative row per walk-forward period should be evaluated');

const periodFailureQuality = candidateBacktestTest.evaluateQuality([
  { status: 'ok', walk_forward_days: 30, total_trades: 40, sharpe_ratio: 1.4, robust_score: 1.2, max_drawdown: 10, win_rate: 55 },
  { status: 'ok', walk_forward_days: 90, total_trades: 35, sharpe_ratio: -0.4, robust_score: -0.2, max_drawdown: 12, win_rate: 42 },
]);
assert.equal(periodFailureQuality.wouldBlock, true, 'any failing representative walk-forward period must block');
assert.ok(periodFailureQuality.reasons.some((reason) => reason.startsWith('walk_forward_period_failed')), 'walk-forward failure reason should identify the failing period');

const lowSampleQuality = candidateBacktestTest.evaluateQuality([
  { status: 'ok', walk_forward_days: 30, total_trades: 3, sharpe_ratio: 1.2, robust_score: 0.9, max_drawdown: 4, win_rate: 67 },
  { status: 'ok', walk_forward_days: 90, total_trades: 4, sharpe_ratio: 1.1, robust_score: 0.8, max_drawdown: 5, win_rate: 60 },
]);
assert.equal(lowSampleQuality.gateStatus, 'would_block_unstable_backtest', 'low trade samples should stabilize before promotion');
assert.ok(lowSampleQuality.reasons.some((reason) => reason.startsWith('backtest_low_trade_sample')), 'low sample reason should be explicit');

const vectorbtSource = readFileSync(new URL('./backtest-vectorbt.py', import.meta.url), 'utf8');
assert.match(vectorbtSource, /ema_trend_pullback/, 'vectorbt grid should include trend-following strategy family');
assert.match(vectorbtSource, /breakout_momentum/, 'vectorbt grid should include breakout strategy family');
assert.match(vectorbtSource, /bollinger_mean_reversion/, 'vectorbt grid should include mean-reversion strategy family');
assert.match(vectorbtSource, /robust_rank_score/, 'vectorbt grid should rank by robust score, not raw Sharpe only');

const payload = {
  ok: true,
  smoke: 'luna-phase1-candidate-backtest',
  dryRunRowsUnchanged: {
    candidateBacktestStatus: beforeStatus == null || afterStatus == null ? 'table_missing_or_unchecked' : beforeStatus === afterStatus,
    predictiveValidationLog: beforeAudit == null || afterAudit == null ? 'table_missing_or_unchecked' : beforeAudit === afterAudit,
  },
  passed: result.passed,
  wouldBlocked: result.wouldBlocked,
  negativeReasons: negative?.reasons || [],
  ohlcvFallbackUsable: candidateBacktestTest.rowsHaveUsableTrades(fallbackRows),
  unrealisticSharpeCapped: unrealisticSharpeQuality.sharpe,
  periodRepresentativeRows: periodRepresentativeQuality.qualityRows.length,
  periodFailureReasons: periodFailureQuality.reasons,
  lowSampleReasons: lowSampleQuality.reasons,
  vectorbtStrategyFamilies: ['rsi_macd_reversal', 'ema_trend_pullback', 'breakout_momentum', 'bollinger_mean_reversion'],
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('luna-phase1-candidate-backtest-smoke ok');
}
