// @ts-nocheck

const DEFAULT_MIN_MISSED_PCT = 3;
const DEFAULT_NEAR_OPTIMAL_GAP_PCT = 1.5;

function number(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 4) {
  const parsed = number(value, null);
  if (parsed == null) return null;
  const scale = 10 ** digits;
  return Math.round(parsed * scale) / scale;
}

function pct(from, to) {
  const start = number(from, null);
  const end = number(to, null);
  if (start == null || end == null || start <= 0) return null;
  return ((end - start) / start) * 100;
}

function ms(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  const date = Date.parse(value);
  return Number.isFinite(date) ? date : null;
}

function day(value) {
  const parsed = ms(value);
  if (parsed == null) return null;
  return new Date(parsed).toISOString().slice(0, 10);
}

function normalizeMarket(row = {}) {
  const market = String(row.market || '').toLowerCase();
  const exchange = String(row.exchange || '').toLowerCase();
  if (market === 'crypto' || exchange.includes('binance')) return 'crypto';
  if (market === 'domestic' || exchange === 'kis') return 'domestic';
  if (market === 'overseas' || exchange.includes('overseas')) return 'overseas';
  return market || 'unknown';
}

function normalizeStrategy(row = {}) {
  return String(row.strategy_family || row.strategyFamily || row.strategy || 'unknown').trim() || 'unknown';
}

function isClosed(row = {}) {
  return String(row.status || '').toLowerCase() === 'closed' || row.exit_time != null || row.exitTime != null;
}

function isLearningEligible(row = {}) {
  return row.exclude_from_learning !== true
    && row.exclude_from_learning !== 'true'
    && String(row.quality_flag || row.qualityFlag || 'trusted').toLowerCase() !== 'exclude_from_learning';
}

export function normalizeDailyBars(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      if (Array.isArray(row)) {
        return {
          time: number(row[0], null),
          date: day(row[0]),
          open: number(row[1], null),
          high: number(row[2], null),
          low: number(row[3], null),
          close: number(row[4], null),
          volume: number(row[5], 0),
        };
      }
      const time = number(row.time ?? row.timestamp ?? row.ts, null) ?? (row.date ? Date.parse(row.date) : null);
      return {
        time,
        date: row.date || day(time),
        open: number(row.open, null),
        high: number(row.high, null),
        low: number(row.low, null),
        close: number(row.close ?? row.price, null),
        volume: number(row.volume, 0),
      };
    })
    .filter((row) => row.time != null && row.close != null && row.close > 0)
    .sort((left, right) => left.time - right.time);
}

function mean(values = []) {
  const nums = values.map((value) => number(value, null)).filter((value) => value != null);
  if (!nums.length) return null;
  return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function sma(values = [], index, period) {
  if (index + 1 < period) return null;
  return mean(values.slice(index + 1 - period, index + 1));
}

function ema(values = [], period) {
  const out = [];
  const k = 2 / (period + 1);
  let prev = null;
  let seed = [];
  for (const raw of values) {
    const value = number(raw, null);
    if (value == null) {
      out.push(null);
      continue;
    }
    if (prev == null) {
      seed.push(value);
      if (seed.length === period) {
        prev = mean(seed);
        out.push(prev);
      } else {
        out.push(null);
      }
      continue;
    }
    prev = value * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsiAt(values = [], index, period = 14) {
  if (index < period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = index - period + 1; i <= index; i += 1) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function bbPosAt(values = [], index, period = 20) {
  if (index + 1 < period) return null;
  const slice = values.slice(index + 1 - period, index + 1);
  const middle = mean(slice);
  const variance = mean(slice.map((value) => (value - middle) ** 2));
  const std = Math.sqrt(variance);
  const upper = middle + std * 2;
  const lower = middle - std * 2;
  if (!(upper > lower)) return null;
  return (values[index] - lower) / (upper - lower);
}

function nextDrawdownPct(bars = [], index, days = 5) {
  const close = bars[index]?.close;
  if (!(close > 0)) return null;
  const future = bars.slice(index + 1, index + 1 + days);
  if (!future.length) return null;
  const minLow = Math.min(...future.map((bar) => number(bar.low, bar.close)).filter((value) => value != null && value > 0));
  if (!Number.isFinite(minLow)) return null;
  return pct(close, minLow);
}

function buildIndicatorSeries(bars = []) {
  const closes = bars.map((bar) => bar.close);
  const volumes = bars.map((bar) => bar.volume || 0);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macd = closes.map((_, index) => (
    ema12[index] != null && ema26[index] != null ? ema12[index] - ema26[index] : null
  ));
  const signal = ema(macd, 9);

  return bars.map((bar, index) => {
    const macdHist = macd[index] != null && signal[index] != null ? macd[index] - signal[index] : null;
    const prevMacdHist = index > 0 && macd[index - 1] != null && signal[index - 1] != null
      ? macd[index - 1] - signal[index - 1]
      : null;
    const volumeBase = mean(volumes.slice(Math.max(0, index - 20), index));
    const nextClose = bars[index + 1]?.close;
    const localWindow = bars.slice(Math.max(0, index - 3), Math.min(bars.length, index + 4));
    const localMax = Math.max(...localWindow.map((item) => item.close));
    return {
      date: bar.date,
      close: round(bar.close),
      high: round(bar.high),
      low: round(bar.low),
      rsi: round(rsiAt(closes, index), 2),
      sma20: round(sma(closes, index, 20)),
      sma50: round(sma(closes, index, 50)),
      macdHist: round(macdHist, 6),
      macdPrev: round(prevMacdHist, 6),
      bbPos: round(bbPosAt(closes, index), 4),
      volumeRatio: volumeBase && volumeBase > 0 ? round((bar.volume || 0) / volumeBase, 4) : null,
      next1dPct: nextClose > 0 ? round(pct(bar.close, nextClose), 3) : null,
      next5dDrawdownPct: round(nextDrawdownPct(bars, index, 5), 3),
      local7dPeak: bar.close >= localMax,
    };
  });
}

function technicalTags(snapshot = {}) {
  const tags = [];
  if (snapshot.rsi != null && snapshot.rsi >= 70) tags.push('rsi_overbought');
  if (snapshot.bbPos != null && snapshot.bbPos >= 0.85) tags.push('upper_bollinger_band');
  if (snapshot.close != null && snapshot.sma20 != null && snapshot.close >= snapshot.sma20 * 1.06) tags.push('sma20_extension_6pct');
  if (snapshot.volumeRatio != null && snapshot.volumeRatio >= 2) tags.push('volume_spike');
  if (snapshot.macdHist != null && snapshot.macdPrev != null && snapshot.macdHist < snapshot.macdPrev) tags.push('macd_cooling');
  if (snapshot.next1dPct != null && snapshot.next1dPct <= -2) tags.push('next_day_drop_over_2pct');
  if (snapshot.next5dDrawdownPct != null && snapshot.next5dDrawdownPct <= -5) tags.push('next5d_drawdown_over_5pct');
  if (snapshot.local7dPeak === true) tags.push('local_7d_peak');
  return tags;
}

function reasonFromTags(tags = []) {
  const labels = {
    rsi_overbought: 'rsi_overbought',
    upper_bollinger_band: 'upper_bollinger_band',
    sma20_extension_6pct: 'sma20_extension_6pct',
    volume_spike: 'volume_spike',
    macd_cooling: 'macd_cooling',
    next_day_drop_over_2pct: 'next_day_drop_over_2pct',
    next5d_drawdown_over_5pct: 'next5d_drawdown_over_5pct',
    local_7d_peak: 'local_7d_peak',
  };
  return tags.map((tag) => labels[tag] || tag).join(' + ') || 'highest_close_after_entry';
}

function findBestBar(bars = []) {
  return bars.reduce((best, bar) => {
    if (!best || number(bar.close, 0) > number(best.close, 0)) return bar;
    return best;
  }, null);
}

function findFirstBarIndexAtOrAfter(bars = [], time = null) {
  const threshold = number(time, null);
  if (threshold == null) return -1;
  return bars.findIndex((bar) => number(bar.time, 0) >= threshold - 24 * 60 * 60 * 1000);
}

function forwardWindowLabel({ bars = [], startTime = null, entryPrice = null, actualPnlPct = null, horizonDays = 5 } = {}) {
  const startIndex = findFirstBarIndexAtOrAfter(bars, startTime);
  if (startIndex < 0 || !(entryPrice > 0)) {
    return {
      horizonDays,
      status: 'insufficient_forward_bars',
      maxCloseDate: null,
      maxClosePnlPct: null,
      driftFromActualPct: null,
      bars: 0,
    };
  }
  const window = bars.slice(startIndex, startIndex + Math.max(1, Number(horizonDays || 1)));
  const best = findBestBar(window);
  const maxClosePnlPct = best ? round(pct(entryPrice, best.close)) : null;
  return {
    horizonDays,
    status: best ? 'materialized' : 'insufficient_forward_bars',
    maxCloseDate: best?.date || null,
    maxClose: round(best?.close),
    maxClosePnlPct,
    driftFromActualPct: maxClosePnlPct != null && actualPnlPct != null
      ? round(maxClosePnlPct - actualPnlPct)
      : null,
    bars: window.length,
  };
}

function buildDualHorizonExitLabels({
  closed = false,
  entryPrice = null,
  exitTime = null,
  exitDay = null,
  exitPrice = null,
  actualPnlPct = null,
  bestDuringHold = null,
  bestDuringHoldPnlPct = null,
  bestToNow = null,
  bestToNowPnlPct = null,
  timingCategory = null,
  bars = [],
} = {}) {
  const forward = {
    '5d': closed ? forwardWindowLabel({ bars, startTime: exitTime, entryPrice, actualPnlPct, horizonDays: 5 }) : null,
    '10d': closed ? forwardWindowLabel({ bars, startTime: exitTime, entryPrice, actualPnlPct, horizonDays: 10 }) : null,
    '20d': closed ? forwardWindowLabel({ bars, startTime: exitTime, entryPrice, actualPnlPct, horizonDays: 20 }) : null,
  };
  return {
    schemaVersion: 1,
    status: closed ? 'materialized' : 'open_position_observe',
    actualExit: closed
      ? {
        date: exitDay,
        price: round(exitPrice),
        pnlPct: round(actualPnlPct),
      }
      : null,
    bestWithinHold: {
      date: bestDuringHold?.date || null,
      price: round(bestDuringHold?.close),
      pnlPct: round(bestDuringHoldPnlPct),
      missedVsActualPct: round(number(bestDuringHoldPnlPct, actualPnlPct) - number(actualPnlPct, 0)),
    },
    bestToNow: {
      date: bestToNow?.date || null,
      price: round(bestToNow?.close),
      pnlPct: round(bestToNowPnlPct),
      missedVsActualPct: round(number(bestToNowPnlPct, actualPnlPct) - number(actualPnlPct, 0)),
    },
    forward,
    timingCategory,
    targets: {
      lateExitAfterPeak: timingCategory === 'late_exit_after_peak',
      earlyLossRecoveredLater: timingCategory === 'early_loss_exit_recovered_later',
      earlyProfitLeftUpside: timingCategory === 'early_profit_exit_left_upside',
      nearOptimal: timingCategory === 'near_optimal_within_hold',
    },
  };
}

function buildPeakReversalRiskLabel(snapshot = {}, tags = []) {
  const tagSet = new Set(tags || []);
  const contributions = [];
  const add = (tag, weight) => {
    if (tagSet.has(tag)) contributions.push({ tag, weight });
  };
  add('next5d_drawdown_over_5pct', 0.35);
  add('next_day_drop_over_2pct', 0.2);
  add('local_7d_peak', 0.14);
  add('upper_bollinger_band', 0.1);
  add('sma20_extension_6pct', 0.08);
  add('rsi_overbought', 0.08);
  add('macd_cooling', 0.07);
  add('volume_spike', 0.05);
  const score = Math.min(0.95, 0.05 + contributions.reduce((sum, item) => sum + item.weight, 0));
  return {
    schemaVersion: 1,
    status: snapshot?.date ? 'materialized' : 'insufficient_peak_snapshot',
    score: snapshot?.date ? round(score, 4) : null,
    bucket: !snapshot?.date ? 'unknown' : score >= 0.7 ? 'high' : score >= 0.4 ? 'medium' : 'low',
    snapshotDate: snapshot?.date || null,
    tags,
    contributions,
    forwardDrawdown5dPct: snapshot?.next5dDrawdownPct ?? null,
    next1dPct: snapshot?.next1dPct ?? null,
  };
}

function classifyTiming({ closed, actualPnlPct, bestDuringHoldPnlPct, bestToNowPnlPct, bestDuringHoldDate, exitDay }) {
  if (!closed) return 'open_position_observe';
  const actual = number(actualPnlPct, 0);
  const missedHold = number(bestDuringHoldPnlPct, actual) - actual;
  const missedToNow = number(bestToNowPnlPct, actual) - actual;
  if (Math.abs(missedHold) <= DEFAULT_NEAR_OPTIMAL_GAP_PCT) return 'near_optimal_within_hold';
  if (missedHold > DEFAULT_MIN_MISSED_PCT && bestDuringHoldDate && exitDay && bestDuringHoldDate < exitDay) return 'late_exit_after_peak';
  if (actual > 0 && missedToNow > DEFAULT_MIN_MISSED_PCT) return 'early_profit_exit_left_upside';
  if (actual < 0 && number(bestToNowPnlPct, 0) > 0 && missedToNow > DEFAULT_MIN_MISSED_PCT) return 'early_loss_exit_recovered_later';
  if (actual < 0 && number(bestToNowPnlPct, 0) <= 0) return 'loss_exit_no_clear_recovery';
  return 'non_optimal_small_gap';
}

function analyzeOneTrade(row = {}, barsInput = []) {
  const bars = normalizeDailyBars(barsInput);
  const entryTime = ms(row.entry_time ?? row.entryTime);
  const exitTime = ms(row.exit_time ?? row.exitTime);
  const entryPrice = number(row.entry_price ?? row.entryPrice, null);
  const exitPrice = number(row.exit_price ?? row.exitPrice, null);
  const closed = isClosed(row);
  if (!entryTime || !(entryPrice > 0) || !bars.length) return null;

  const entryDay = day(entryTime);
  const exitDay = closed ? day(exitTime) : null;
  const analysisBars = bars.filter((bar) => bar.time >= entryTime - 24 * 60 * 60 * 1000);
  const holdBars = analysisBars.filter((bar) => {
    if (bar.time < entryTime - 24 * 60 * 60 * 1000) return false;
    if (closed && exitTime) return bar.time <= exitTime + 24 * 60 * 60 * 1000;
    return true;
  });
  const bestDuringHold = findBestBar(holdBars);
  const bestToNow = findBestBar(analysisBars);
  const current = bars[bars.length - 1] || null;
  const indicators = buildIndicatorSeries(bars);
  const byDate = new Map(indicators.map((item) => [item.date, item]));
  const bestDuringTechnical = byDate.get(bestDuringHold?.date) || null;
  const bestToNowTechnical = byDate.get(bestToNow?.date) || null;
  const bestDuringTags = technicalTags(bestDuringTechnical || {});
  const bestToNowTags = technicalTags(bestToNowTechnical || {});
  const actualPnl = closed && exitPrice > 0
    ? pct(entryPrice, exitPrice)
    : number(row.pnl_percent ?? row.pnlPercent, null);
  const bestDuringHoldPnlPct = bestDuringHold ? pct(entryPrice, bestDuringHold.close) : null;
  const bestToNowPnlPct = bestToNow ? pct(entryPrice, bestToNow.close) : null;
  const timingCategory = classifyTiming({
    closed,
    actualPnlPct: actualPnl,
    bestDuringHoldPnlPct,
    bestToNowPnlPct,
    bestDuringHoldDate: bestDuringHold?.date,
    exitDay,
  });
  const exitLabels = buildDualHorizonExitLabels({
    closed,
    entryPrice,
    exitTime,
    exitDay,
    exitPrice,
    actualPnlPct: actualPnl,
    bestDuringHold,
    bestDuringHoldPnlPct,
    bestToNow,
    bestToNowPnlPct,
    timingCategory,
    bars,
  });
  const peakReversalRisk = buildPeakReversalRiskLabel(bestToNowTechnical || {}, bestToNowTags);

  return {
    tradeId: row.trade_id || row.tradeId || String(row.id || ''),
    market: normalizeMarket(row),
    exchange: row.exchange || null,
    symbol: row.symbol || null,
    status: closed ? 'closed' : 'open',
    closed,
    direction: row.direction || 'long',
    learningEligible: isLearningEligible(row),
    qualityFlag: row.quality_flag || row.qualityFlag || null,
    executionOrigin: row.execution_origin || row.executionOrigin || null,
    strategyFamily: normalizeStrategy(row),
    marketRegime: row.market_regime || row.marketRegime || null,
    entryDate: entryTime ? new Date(entryTime).toISOString() : null,
    entryDay,
    entryPrice: round(entryPrice),
    exitDate: exitTime ? new Date(exitTime).toISOString() : null,
    exitDay,
    exitPrice: round(exitPrice),
    actualPnlPct: round(actualPnl),
    currentDate: current?.date || null,
    currentPrice: round(current?.close),
    currentFromEntryPct: round(current ? pct(entryPrice, current.close) : null),
    bestDuringHoldCloseDate: bestDuringHold?.date || null,
    bestDuringHoldClose: round(bestDuringHold?.close),
    bestDuringHoldClosePnlPct: round(bestDuringHoldPnlPct),
    bestDuringHoldHighDate: bestDuringHold?.date || null,
    bestDuringHoldHigh: round(bestDuringHold?.high),
    bestDuringHoldHighPnlPct: round(bestDuringHold ? pct(entryPrice, bestDuringHold.high) : null),
    bestToNowCloseDate: bestToNow?.date || null,
    bestToNowClose: round(bestToNow?.close),
    bestToNowClosePnlPct: round(bestToNowPnlPct),
    missedDuringHoldClosePct: round(number(bestDuringHoldPnlPct, actualPnl) - number(actualPnl, 0)),
    missedToNowClosePct: round(number(bestToNowPnlPct, actualPnl) - number(actualPnl, 0)),
    timingCategory,
    exitLabels,
    peakReversalRisk,
    bestDuringHoldTechnical: bestDuringTechnical ? { ...bestDuringTechnical, tags: bestDuringTags } : null,
    bestToNowTechnical: bestToNowTechnical ? { ...bestToNowTechnical, tags: bestToNowTags } : null,
    bestToNowReason: reasonFromTags(bestToNowTags),
    barsAvailable: bars.length,
  };
}

function createSummary() {
  return {
    total: 0,
    closed: 0,
    open: 0,
    symbols: 0,
    actualAvgPnlPct: null,
    actualMedianPnlPct: null,
    winRate: null,
    currentFromEntryAvgPct: null,
    bestDuringHoldAvgPct: null,
    bestToNowAvgPct: null,
    missedDuringHoldAvgPct: null,
    missedToNowAvgPct: null,
    missedDuringHoldMedianPct: null,
    missedToNowMedianPct: null,
    p90MissedToNowPct: null,
    timingCategories: {},
    optimalReasonTags: {},
    exitLabelCoverage: {
      status: 'empty',
      dualHorizonLabels: 0,
      forward5dLabels: 0,
      forward10dLabels: 0,
      forward20dLabels: 0,
      peakDrawdownLabels: 0,
    },
    peakReversalRisk: {
      status: 'empty',
      scored: 0,
      high: 0,
      medium: 0,
      low: 0,
      avgScore: null,
    },
  };
}

function median(values = []) {
  const nums = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function percentile(values = [], p = 0.9) {
  const nums = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (!nums.length) return null;
  const index = Math.min(nums.length - 1, Math.max(0, Math.ceil(nums.length * p) - 1));
  return nums[index];
}

function summarize(records = []) {
  const summary = createSummary();
  const symbols = new Set();
  const actual = [];
  const current = [];
  const bestHold = [];
  const bestNow = [];
  const missedHold = [];
  const missedNow = [];
  const peakScores = [];
  let wins = 0;
  for (const record of records) {
    summary.total += 1;
    if (record.closed) summary.closed += 1;
    else summary.open += 1;
    if (record.symbol) symbols.add(`${record.market}:${record.symbol}`);
    if (Number.isFinite(record.actualPnlPct)) {
      actual.push(record.actualPnlPct);
      if (record.actualPnlPct > 0) wins += 1;
    }
    if (Number.isFinite(record.currentFromEntryPct)) current.push(record.currentFromEntryPct);
    if (Number.isFinite(record.bestDuringHoldClosePnlPct)) bestHold.push(record.bestDuringHoldClosePnlPct);
    if (Number.isFinite(record.bestToNowClosePnlPct)) bestNow.push(record.bestToNowClosePnlPct);
    if (Number.isFinite(record.missedDuringHoldClosePct)) missedHold.push(record.missedDuringHoldClosePct);
    if (Number.isFinite(record.missedToNowClosePct)) missedNow.push(record.missedToNowClosePct);
    if (record.exitLabels?.status === 'materialized') summary.exitLabelCoverage.dualHorizonLabels += 1;
    if (record.exitLabels?.forward?.['5d']?.status === 'materialized') summary.exitLabelCoverage.forward5dLabels += 1;
    if (record.exitLabels?.forward?.['10d']?.status === 'materialized') summary.exitLabelCoverage.forward10dLabels += 1;
    if (record.exitLabels?.forward?.['20d']?.status === 'materialized') summary.exitLabelCoverage.forward20dLabels += 1;
    if (record.peakReversalRisk?.forwardDrawdown5dPct != null) summary.exitLabelCoverage.peakDrawdownLabels += 1;
    if (record.peakReversalRisk?.score != null) {
      peakScores.push(record.peakReversalRisk.score);
      summary.peakReversalRisk.scored += 1;
      const bucket = record.peakReversalRisk.bucket || 'low';
      summary.peakReversalRisk[bucket] = (summary.peakReversalRisk[bucket] || 0) + 1;
    }
    summary.timingCategories[record.timingCategory] = (summary.timingCategories[record.timingCategory] || 0) + 1;
    for (const tag of record.bestToNowTechnical?.tags || []) {
      summary.optimalReasonTags[tag] = (summary.optimalReasonTags[tag] || 0) + 1;
    }
  }
  summary.symbols = symbols.size;
  summary.actualAvgPnlPct = round(mean(actual));
  summary.actualMedianPnlPct = round(median(actual));
  summary.winRate = actual.length ? round(wins / actual.length, 4) : null;
  summary.currentFromEntryAvgPct = round(mean(current));
  summary.bestDuringHoldAvgPct = round(mean(bestHold));
  summary.bestToNowAvgPct = round(mean(bestNow));
  summary.missedDuringHoldAvgPct = round(mean(missedHold));
  summary.missedToNowAvgPct = round(mean(missedNow));
  summary.missedDuringHoldMedianPct = round(median(missedHold));
  summary.missedToNowMedianPct = round(median(missedNow));
  summary.p90MissedToNowPct = round(percentile(missedNow, 0.9));
  summary.exitLabelCoverage.status = summary.exitLabelCoverage.dualHorizonLabels > 0
    ? 'materialized'
    : 'empty';
  summary.exitLabelCoverage.coverage = summary.total > 0
    ? round(summary.exitLabelCoverage.dualHorizonLabels / summary.total, 4)
    : 0;
  summary.peakReversalRisk.status = summary.peakReversalRisk.scored > 0
    ? 'materialized'
    : 'empty';
  summary.peakReversalRisk.avgScore = round(mean(peakScores));
  summary.optimalReasonTags = Object.fromEntries(
    Object.entries(summary.optimalReasonTags).sort((a, b) => b[1] - a[1]),
  );
  summary.timingCategories = Object.fromEntries(
    Object.entries(summary.timingCategories).sort((a, b) => b[1] - a[1]),
  );
  return summary;
}

function groupSummaries(records = [], keyFn) {
  const groups = {};
  for (const record of records) {
    const key = keyFn(record) || 'unknown';
    if (!groups[key]) groups[key] = [];
    groups[key].push(record);
  }
  return Object.entries(groups)
    .map(([key, rows]) => ({ key, ...summarize(rows) }))
    .sort((left, right) => right.total - left.total || left.key.localeCompare(right.key));
}

function buildRecommendations(summary = createSummary()) {
  const labelsMaterialized = summary.exitLabelCoverage?.status === 'materialized';
  const peakRiskMaterialized = summary.peakReversalRisk?.status === 'materialized';
  return [
    {
      id: 'dual_horizon_exit_labeling',
      priority: labelsMaterialized ? 'P1' : 'P0',
      finding: `missedDuringHoldAvgPct=${summary.missedDuringHoldAvgPct}, missedToNowAvgPct=${summary.missedToNowAvgPct}`,
      action: labelsMaterialized
        ? 'Wire materialized actual/best/forward exit labels into exit patience, partial profit, and trailing decisions.'
        : 'Train separate labels for actual exit, best within hold, forward 5/10/20d max return, and peak drawdown.',
      evidence: { exitLabelCoverage: summary.exitLabelCoverage },
    },
    {
      id: 'peak_reversal_probability_head',
      priority: peakRiskMaterialized ? 'P1' : 'P0',
      finding: `topTags=${JSON.stringify(Object.fromEntries(Object.entries(summary.optimalReasonTags || {}).slice(0, 5)))}`,
      action: peakRiskMaterialized
        ? 'Wire materialized peakReversalRisk labels into partial-profit and trailing-stop sell gates.'
        : 'Add a peak/reversal probability head using RSI, Bollinger position, SMA20 extension, volume spike, MACD cooling, and forward drawdown labels.',
      evidence: { peakReversalRisk: summary.peakReversalRisk },
    },
    {
      id: 'early_exit_recovery_gate',
      priority: 'P1',
      finding: `timingCategories=${JSON.stringify(summary.timingCategories || {})}`,
      action: 'For non-hard loss exits, require one recheck when RSI/MACD/SMA20 recovery signals are improving.',
    },
    {
      id: 'profit_trailing_engine',
      priority: 'P1',
      finding: `nearOptimal=${summary.timingCategories?.near_optimal_within_hold || 0}, lateExit=${summary.timingCategories?.late_exit_after_peak || 0}`,
      action: 'Use partial profit lock plus ATR/chandelier trailing instead of a single all-or-nothing profit exit.',
    },
    {
      id: 'symbol_strategy_penalty',
      priority: 'P1',
      finding: 'symbol and strategy family timing gaps vary materially',
      action: 'Feed symbol x strategy_family early/late exit penalty back into entry sizing and exit patience.',
    },
  ];
}

export function buildOptimalExitAnalysisReport({
  trades = [],
  barsBySymbol = {},
  generatedAt = new Date().toISOString(),
  priceFetchErrors = [],
  includeRecords = false,
  maxRecords = null,
} = {}) {
  const records = [];
  const errors = [...priceFetchErrors];
  for (const row of trades) {
    const market = normalizeMarket(row);
    const symbol = row.symbol || '';
    const key = `${market}:${symbol}`;
    const bars = barsBySymbol[key] || barsBySymbol[symbol] || [];
    const record = analyzeOneTrade(row, bars);
    if (record) records.push(record);
    else errors.push({ key, tradeId: row.trade_id || row.tradeId || null, reason: 'insufficient_trade_or_price_data' });
  }
  const learningEligibleRecords = records.filter((record) => record.learningEligible);
  const summary = summarize(records);
  const learningEligibleSummary = summarize(learningEligibleRecords);
  const topMissedDuringHold = [...records]
    .sort((left, right) => number(right.missedDuringHoldClosePct, -Infinity) - number(left.missedDuringHoldClosePct, -Infinity))
    .slice(0, 25);
  const topMissedToNow = [...records]
    .sort((left, right) => number(right.missedToNowClosePct, -Infinity) - number(left.missedToNowClosePct, -Infinity))
    .slice(0, 25);
  const report = {
    ok: records.length > 0,
    status: records.length > 0 ? 'ready' : 'insufficient_data',
    generatedAt,
    scope: {
      journalRows: trades.length,
      analyzedTrades: records.length,
      learningEligibleTrades: learningEligibleRecords.length,
      priceSymbolsProvided: Object.keys(barsBySymbol || {}).length,
      priceFetchErrors: errors.length,
    },
    summary,
    learningEligibleSummary,
    byMarket: groupSummaries(records, (record) => record.market),
    byStrategyFamily: groupSummaries(records, (record) => record.strategyFamily),
    bySymbol: groupSummaries(records, (record) => `${record.market}:${record.symbol}`).slice(0, 200),
    openPositions: records.filter((record) => !record.closed),
    topMissedDuringHold,
    topMissedToNow,
    recommendations: buildRecommendations(learningEligibleSummary.total > 0 ? learningEligibleSummary : summary),
    errors: errors.slice(0, 100),
  };
  if (includeRecords) {
    const limit = Number(maxRecords);
    report.records = Number.isFinite(limit) && limit > 0 ? records.slice(0, limit) : records;
  }
  return report;
}

export default {
  normalizeDailyBars,
  buildOptimalExitAnalysisReport,
};
