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

const cappedResult = await runCandidateBacktestRefresh({
  json: true,
  dryRun: true,
  fixture: true,
  periods: '30',
  limit: 10,
  maxSymbols: 1,
});
assert.equal(cappedResult.total, 1, 'maxSymbols should cap processed candidates');
assert.equal(cappedResult.candidateBudget.truncatedByMaxSymbols, true, 'candidate budget should report symbol truncation');
assert.equal(cappedResult.candidateBudget.selectedBeforeBudget, 2, 'candidate budget should expose pre-cap selection size');
assert.equal(cappedResult.candidateBudget.selected, 1, 'candidate budget should expose capped selection size');
assert.equal(cappedResult.candidateBudget.orderingPolicy, 'backtest_due_priority_then_market_round_robin_score_desc', 'candidate budget should expose ordering policy');

const runtimeBudgetResult = await runCandidateBacktestRefresh({
  json: true,
  dryRun: true,
  fixture: true,
  periods: '30',
  limit: 10,
  maxRuntimeMs: 0,
});
assert.equal(runtimeBudgetResult.total, 0, 'zero runtime budget should skip processing before first candidate');
assert.equal(runtimeBudgetResult.candidateBudget.budgetStopped, true, 'candidate budget should report runtime stop');
assert.equal(runtimeBudgetResult.candidateBudget.skippedByRuntimeBudget, 2, 'candidate budget should count runtime-budget skipped candidates');

const requestedOutsideUniverseResult = await runCandidateBacktestRefresh({
  json: true,
  dryRun: true,
  fixture: true,
  periods: '30',
  market: 'domestic',
  symbols: '071200',
  limit: 10,
});
assert.equal(requestedOutsideUniverseResult.total, 1, 'explicit requested symbol should run even when absent from active candidate selection');
assert.equal(requestedOutsideUniverseResult.results[0].symbol, '071200', 'requested symbol should be preserved');
assert.equal(requestedOutsideUniverseResult.results[0].market, 'domestic', 'requested symbol should use requested market');
assert.equal(requestedOutsideUniverseResult.candidateBudget.selectedBeforeBudget, 1, 'requested symbol override should count as selected candidate');

const syntheticOhlcv = Array.from({ length: 80 }, (_, index) => {
  const close = 100 + index * 0.25 + Math.sin(index / 5) * 1.5;
  return [Date.now() - (80 - index) * 3600_000, close - 0.5, close + 0.8, close - 0.9, close, 1000 + index];
});
const fallbackRows = candidateBacktestTest.buildOhlcvMomentumBacktestRows(syntheticOhlcv, 30, 'crypto');
assert.equal(candidateBacktestTest.rowsHaveUsableTrades(fallbackRows), true, 'OHLCV fallback should produce usable trade rows for trending candles');
assert.equal(candidateBacktestTest.rowsHaveUsableTrades([
  { status: 'insufficient_data', selection_method: 'walk_forward', oos_status: 'insufficient_data', total_trades: 3, n_obs_oos: 214, total_trades_oos: 3 },
]), true, 'walk-forward OOS insufficiency should be preserved instead of overwritten by fallback rows');
const fallbackQuality = candidateBacktestTest.evaluateQuality(fallbackRows);
assert.equal(fallbackQuality.fresh ?? true, true, 'usable OHLCV fallback should be considered fresh');
assert.equal(fallbackQuality.qualityRowSelection, 'best_per_walk_forward_period', 'quality gate should use period representatives');
const fallbackNoOosQuality = candidateBacktestTest.applyFallbackNoOosGate({ ...fallbackQuality }, true);
assert.equal(fallbackNoOosQuality.healthy, false, 'OOS-less fallback rows must not be healthy');
assert.equal(fallbackNoOosQuality.wouldBlock, true, 'OOS-less fallback rows must would-block');
assert.equal(fallbackNoOosQuality.gateStatus, 'would_block_no_oos', 'OOS-less fallback rows should have an explicit no-OOS gate status');
assert.ok(fallbackNoOosQuality.reasons.includes('fallback_no_oos_validation'), 'OOS-less fallback block reason should be explicit');
const legacyNoOosQuality = candidateBacktestTest.applyFallbackNoOosGate(candidateBacktestTest.evaluateQuality([
  { status: 'ok', walk_forward_days: 365, total_trades: 30, sharpe_ratio: 1.2, max_drawdown: 10, win_rate: 55 },
]), false, { enforceAnyNoOos: true });
assert.equal(legacyNoOosQuality.healthy, false, 'non-fixture OOS-less backtests must not be healthy even when fallback was not used');
assert.equal(legacyNoOosQuality.gateStatus, 'would_block_no_oos', 'non-fixture OOS-less backtests should have an explicit no-OOS gate status');
assert.ok(legacyNoOosQuality.reasons.includes('backtest_no_oos_validation'), 'non-fallback OOS-less block reason should be explicit');
const walkForwardOosQuality = candidateBacktestTest.applyFallbackNoOosGate(candidateBacktestTest.evaluateQuality([
  {
    status: 'ok',
    selection_method: 'walk_forward',
    oos_status: 'ok',
    walk_forward_days: 365,
    total_trades: 30,
    total_trades_oos: 12,
    n_obs_oos: 109,
    sharpe_ratio: 1.4,
    sharpe_is: 1.4,
    sharpe_oos: 1.2,
    sharpe_oos_deflated: 1.1,
    max_drawdown: 10,
    win_rate: 55,
    dsr: 0.91,
    psr: 0.97,
    sr0: 0.022,
    sr_oos_unann: 0.011,
    periods_per_year: 105120,
  },
]), false);
assert.equal(walkForwardOosQuality.gateStatus, 'pass', 'walk-forward OOS rows should stay eligible when fallback was not used');
assert.equal(walkForwardOosQuality.healthy, true, 'walk-forward OOS rows should remain healthy when they pass quality gates');
assert.equal(walkForwardOosQuality.dsr, 0.91, 'DSR shadow value should be carried without changing gate status');
assert.equal(walkForwardOosQuality.periodsPerYear, 105120, 'DSR annualization factor should be carried for audit');

const officialDomesticRows = candidateBacktestTest.buildOfficialDomesticOhlcvRows([
  { basDt: '20260520', mkp: '1000', hipr: '1030', lopr: '990', clpr: '1020', trqu: '10000' },
  { basDt: '20260519', mkp: '980', hipr: '1010', lopr: '970', clpr: '1000', trqu: '9000' },
]);
assert.equal(officialDomesticRows.length, 2, 'Data.go.kr stock price rows should convert to OHLCV rows');
assert.ok(officialDomesticRows[0][0] < officialDomesticRows[1][0], 'official domestic OHLCV rows should be sorted oldest first');
const insufficientOfficialQuality = candidateBacktestTest.evaluateQuality([
  { status: 'insufficient_official_ohlcv', total_trades: 0, params: { fallback: 'data_go_kr_stock_price_history', officialRows: 1 } },
]);
assert.equal(insufficientOfficialQuality.fresh, true, 'attempted official fallback should be fresh even when history is insufficient');
assert.ok(insufficientOfficialQuality.reasons.includes('backtest_insufficient_official_ohlcv'), 'official fallback insufficiency should be explicit');

const interleavedMarkets = candidateBacktestTest.interleaveCandidatesByMarket([
  { symbol: 'ZEC/USDT', market: 'crypto' },
  { symbol: 'DASH/USDT', market: 'crypto' },
  { symbol: '005930', market: 'domestic' },
  { symbol: '000660', market: 'domestic' },
  { symbol: 'NVDA', market: 'overseas' },
  { symbol: 'MSFT', market: 'overseas' },
]).map((item) => item.market);
assert.deepEqual(
  interleavedMarkets,
  ['crypto', 'domestic', 'overseas', 'crypto', 'domestic', 'overseas'],
  'backtest refresh should not spend the entire runtime budget on one market first',
);

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
assert.equal(periodRepresentativeQuality.qualityRowSelectionPolicy, 'stable_sample_first', 'representative row selection should prioritize stable samples');

const lowSampleHighSharpeRepresentativeQuality = candidateBacktestTest.evaluateQuality([
  { status: 'ok', walk_forward_days: 30, total_trades: 4, sharpe_ratio: 52, robust_score: 30, max_drawdown: 2, win_rate: 75 },
  { status: 'ok', walk_forward_days: 30, total_trades: 24, sharpe_ratio: 1.1, robust_score: 0.7, max_drawdown: 9, win_rate: 54 },
  { status: 'ok', walk_forward_days: 90, total_trades: 28, sharpe_ratio: 0.9, robust_score: 0.5, max_drawdown: 11, win_rate: 51 },
]);
assert.equal(lowSampleHighSharpeRepresentativeQuality.gateStatus, 'pass', 'low-sample unrealistic Sharpe rows must not beat stable representative rows');
assert.equal(lowSampleHighSharpeRepresentativeQuality.qualityRows[0].total_trades, 24, 'stable-sample row should represent the 30d period');

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
const backtestRefreshSource = readFileSync(new URL('./runtime-luna-candidate-backtest-refresh.ts', import.meta.url), 'utf8');
assert.match(vectorbtSource, /ema_trend_pullback/, 'vectorbt grid should include trend-following strategy family');
assert.match(vectorbtSource, /breakout_momentum/, 'vectorbt grid should include breakout strategy family');
assert.match(vectorbtSource, /bollinger_mean_reversion/, 'vectorbt grid should include mean-reversion strategy family');
assert.match(vectorbtSource, /robust_rank_score/, 'vectorbt grid should rank by robust score, not raw Sharpe only');
assert.match(vectorbtSource, /infer_portfolio_freq/, 'vectorbt backtest should infer portfolio frequency from OHLCV interval');
assert.match(vectorbtSource, /freq=portfolio_freq/, 'vectorbt backtest should not hard-code 5min frequency for stock data');
assert.match(backtestRefreshSource, /deadlineAt/, 'backtest refresh should enforce runtime budgets inside candidate periods');
assert.match(backtestRefreshSource, /backtest_runtime_budget_partial/, 'partial runtime-budget backtests should not be allowed to pass silently');
assert.match(backtestRefreshSource, /ohlcv_fallback_timeout/, 'OHLCV fallback should be bounded by the remaining runtime budget');
assert.match(backtestRefreshSource, /runtime_budget_stop_before_fallback/, 'OHLCV fallback should not start when runtime budget is exhausted');

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
  fallbackNoOosGateStatus: fallbackNoOosQuality.gateStatus,
  legacyNoOosGateStatus: legacyNoOosQuality.gateStatus,
  walkForwardOosGateStatus: walkForwardOosQuality.gateStatus,
  unrealisticSharpeCapped: unrealisticSharpeQuality.sharpe,
  periodRepresentativeRows: periodRepresentativeQuality.qualityRows.length,
  stableSampleFirst: lowSampleHighSharpeRepresentativeQuality.gateStatus === 'pass',
  periodFailureReasons: periodFailureQuality.reasons,
  lowSampleReasons: lowSampleQuality.reasons,
  vectorbtStrategyFamilies: ['rsi_macd_reversal', 'ema_trend_pullback', 'breakout_momentum', 'bollinger_mean_reversion'],
  vectorbtFrequencyInference: true,
  runtimeBudgetPartialGuard: true,
  fallbackRuntimeBudgetGuard: true,
  marketRoundRobinScheduling: true,
  candidateBudget: {
    maxSymbolsCapWorks: cappedResult.candidateBudget.selected === 1,
    runtimeBudgetStopWorks: runtimeBudgetResult.candidateBudget.budgetStopped === true,
    requestedOutsideUniverseWorks: requestedOutsideUniverseResult.total === 1,
  },
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log('luna-phase1-candidate-backtest-smoke ok');
}
