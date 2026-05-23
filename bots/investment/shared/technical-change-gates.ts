// @ts-nocheck

const DISABLE_VALUES = new Set(['0', 'false', 'off', 'disabled', 'no']);
const ENABLE_VALUES = new Set(['1', 'true', 'on', 'enabled', 'yes']);
const HARD_EXIT_REASONS = new Set([
  'stop_loss_threshold',
  'dynamic_trail_stop_breached',
  'backtest_drift_exit',
  'mtf_bearish_consensus_exit',
  'tv_4h_bearish_reversal',
  'breakout_failed',
]);

function boolEnv(name, fallback = true, env = process.env) {
  const raw = String(env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (ENABLE_VALUES.has(raw)) return true;
  if (DISABLE_VALUES.has(raw)) return false;
  return fallback;
}

function numEnv(name, fallback = 0, env = process.env) {
  const value = Number(env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function finiteNumber(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, digits = 4) {
  const parsed = finiteNumber(value, null);
  if (parsed == null) return null;
  const scale = 10 ** digits;
  return Math.round(parsed * scale) / scale;
}

function normalizeSignal(value = '') {
  const signal = String(value || '').trim().toUpperCase();
  if (signal === 'BUY' || signal === 'BULLISH' || signal === 'LONG') return 'BUY';
  if (signal === 'SELL' || signal === 'BEARISH' || signal === 'SHORT') return 'SELL';
  return 'HOLD';
}

function normalizeSetup(value = '') {
  return String(value || '').trim().toLowerCase();
}

function isMeanReversionSetup(candidate = {}) {
  const values = [
    candidate?.setup_type,
    candidate?.setupType,
    candidate?.strategy_family,
    candidate?.strategyFamily,
    candidate?.strategy_route?.selectedFamily,
    candidate?.strategy_route?.setupType,
    candidate?.strategyRoute?.selectedFamily,
    candidate?.strategyRoute?.setupType,
  ].map(normalizeSetup);
  return values.some((value) => value.includes('mean') || value.includes('pullback'));
}

function getFirstNumber(...values) {
  for (const value of values) {
    const parsed = finiteNumber(value, null);
    if (parsed != null) return parsed;
  }
  return null;
}

function normalizeBbPosition(value) {
  const parsed = finiteNumber(value, null);
  if (parsed == null) return null;
  if (Math.abs(parsed) > 2 && Math.abs(parsed) <= 100) return parsed / 100;
  return parsed;
}

function normalizeBar(row = {}) {
  if (Array.isArray(row)) {
    return {
      time: finiteNumber(row[0], null),
      open: finiteNumber(row[1], null),
      high: finiteNumber(row[2], null),
      low: finiteNumber(row[3], null),
      close: finiteNumber(row[4], null),
      volume: finiteNumber(row[5], 0),
    };
  }
  const time = finiteNumber(row.timestamp ?? row.time ?? row.ts, null)
    ?? (row.date ? Date.parse(row.date) : null);
  return {
    time,
    open: finiteNumber(row.open ?? row.Open, null),
    high: finiteNumber(row.high ?? row.High, null),
    low: finiteNumber(row.low ?? row.Low, null),
    close: finiteNumber(row.close ?? row.Close ?? row.price, null),
    volume: finiteNumber(row.volume ?? row.Volume, 0),
  };
}

function normalizeBars(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map(normalizeBar)
    .filter((row) => row.close != null && row.close > 0)
    .sort((left, right) => Number(left.time || 0) - Number(right.time || 0));
}

function sma(values = [], period = 20) {
  if (values.length < period) return null;
  const slice = values.slice(-period).map((value) => finiteNumber(value, null));
  if (slice.some((value) => value == null)) return null;
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

function emaSeries(values = [], period = 12) {
  const out = [];
  const k = 2 / (period + 1);
  let prev = null;
  let seed = [];
  for (const value of values) {
    const parsed = finiteNumber(value, null);
    if (parsed == null) {
      out.push(null);
      continue;
    }
    if (prev == null) {
      seed.push(parsed);
      if (seed.length === period) {
        prev = seed.reduce((sum, item) => sum + item, 0) / period;
        out.push(prev);
      } else {
        out.push(null);
      }
      continue;
    }
    prev = parsed * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function rsi(values = [], period = 14) {
  if (values.length < period + 1) return null;
  let gains = 0;
  let losses = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const diff = finiteNumber(values[index], 0) - finiteNumber(values[index - 1], 0);
    if (diff >= 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function latestMacdHist(values = []) {
  if (values.length < 35) return null;
  const ema12 = emaSeries(values, 12);
  const ema26 = emaSeries(values, 26);
  const macd = values.map((_, index) => (
    ema12[index] != null && ema26[index] != null ? ema12[index] - ema26[index] : null
  ));
  const signal = emaSeries(macd, 9);
  const latestMacd = macd[macd.length - 1];
  const latestSignal = signal[signal.length - 1];
  return latestMacd != null && latestSignal != null ? latestMacd - latestSignal : null;
}

function latestBbPosition(values = [], period = 20) {
  if (values.length < period) return null;
  const latest = values[values.length - 1];
  const middle = sma(values, period);
  const slice = values.slice(-period);
  const variance = slice.reduce((sum, value) => sum + ((value - middle) ** 2), 0) / period;
  const std = Math.sqrt(variance);
  const upper = middle + (2 * std);
  const lower = middle - (2 * std);
  if (!(upper > lower)) return null;
  return (latest - lower) / (upper - lower);
}

function buildBarIndicatorSnapshot(rows = []) {
  const bars = normalizeBars(rows);
  if (bars.length < 20) return null;
  const closes = bars.map((bar) => bar.close);
  const latest = bars[bars.length - 1];
  return {
    price: latest.close,
    rsi: rsi(closes, 14),
    macdHist: latestMacdHist(closes),
    sma20: sma(closes, 20),
    sma50: sma(closes, 50),
    bbPos: latestBbPosition(closes, 20),
    bars: bars.length,
    source: 'daily_bars_computed',
  };
}

function pickObject(...values) {
  for (const value of values) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  }
  return {};
}

export function resolveTechnicalEntrySnapshot({
  candidate = {},
  event = null,
  chartGuard = null,
  fireReadiness = null,
  context = {},
} = {}) {
  const hints = pickObject(candidate?.triggerHints, event?.triggerHints, context?.triggerHints);
  const telemetry = pickObject(hints?.technicalTelemetry, context?.technicalTelemetry);
  const blockMeta = pickObject(candidate?.block_meta);
  const snapshot = pickObject(
    candidate?.technicalSnapshot,
    candidate?.entryChartSnapshot,
    candidate?.tradingViewSnapshot,
    event?.technicalSnapshot,
    event?.entryChartSnapshot,
    event?.tradingViewSnapshot,
    chartGuard?.snapshot,
  );
  const direct = pickObject(
    candidate?.indicators,
    hints?.indicators,
    telemetry?.indicators,
    blockMeta?.indicators,
    snapshot?.indicators,
    snapshot,
  );
  const computed = buildBarIndicatorSnapshot(
    snapshot?.dailyBars
    || snapshot?.daily_bars
    || snapshot?.ohlcv
    || direct?.dailyBars
    || direct?.ohlcv
    || [],
  ) || {};
  const details = fireReadiness?.details || fireReadiness || {};
  const mtfDominantSignal = normalizeSignal(
    details.mtfDominantSignal
    ?? hints.mtfDominantSignal
    ?? hints.dominantSignal
    ?? context?.mtfDominantSignal,
  );
  const mtfAlignmentScore = getFirstNumber(details.mtfAlignmentScore, hints.mtfAlignmentScore, hints.alignmentScore, context?.mtfAlignmentScore);
  const mtfBullish = details.mtfBullish === true
    || mtfDominantSignal === 'BUY'
    || (mtfDominantSignal === 'HOLD' && mtfAlignmentScore != null && mtfAlignmentScore > 0);
  const volumeBurst = getFirstNumber(details.volumeBurst, hints.volumeBurst, context?.volumeBurst, direct?.volumeBurst, direct?.volumeRatio);
  const breakoutRetest = details.breakoutRetest === true
    || hints.breakoutRetest === true
    || context?.breakoutRetest === true;
  const price = getFirstNumber(
    direct.currentPrice,
    direct.price,
    direct.close,
    candidate?.entry_price,
    candidate?.entryPrice,
    computed.price,
  );
  return {
    available: Boolean(
      getFirstNumber(direct.rsi, direct.rsi14, computed.rsi) != null
      || getFirstNumber(direct.macdHist, direct.macd_hist, direct.macd?.histogram, computed.macdHist) != null
      || getFirstNumber(direct.sma20, direct.ma20, computed.sma20) != null
      || getFirstNumber(direct.sma50, direct.ma50, computed.sma50) != null
      || normalizeBbPosition(direct.bbPos ?? direct.bbPct ?? direct.bb_pct ?? direct.bollingerPosition ?? computed.bbPos) != null
    ),
    price,
    rsi: getFirstNumber(direct.rsi, direct.rsi14, computed.rsi),
    macdHist: getFirstNumber(direct.macdHist, direct.macd_hist, direct.macd?.histogram, computed.macdHist),
    sma20: getFirstNumber(direct.sma20, direct.ma20, direct.bbMiddle, computed.sma20),
    sma50: getFirstNumber(direct.sma50, direct.ma50, computed.sma50),
    bbPos: normalizeBbPosition(direct.bbPos ?? direct.bbPct ?? direct.bb_pct ?? direct.bollingerPosition ?? computed.bbPos),
    volumeBurst,
    mtfBullish,
    mtfDominantSignal,
    mtfAlignmentScore,
    breakoutRetest,
    source: computed.source || direct.source || snapshot.source || telemetry.source || null,
  };
}

function confirmationCount(snapshot = {}) {
  const checks = [];
  if (snapshot.rsi != null) checks.push({ name: 'rsi_above_50', ok: snapshot.rsi >= 50 });
  if (snapshot.macdHist != null) checks.push({ name: 'macd_hist_positive', ok: snapshot.macdHist > 0 });
  if (snapshot.price != null && snapshot.sma20 != null) checks.push({ name: 'price_above_sma20', ok: snapshot.price >= snapshot.sma20 });
  if (snapshot.sma20 != null && snapshot.sma50 != null) checks.push({ name: 'sma20_above_sma50', ok: snapshot.sma20 >= snapshot.sma50 });
  return {
    available: checks.length,
    passed: checks.filter((check) => check.ok).length,
    checks,
  };
}

export function evaluateTechnicalEntryChangeGate({
  candidate = {},
  event = null,
  chartGuard = null,
  context = {},
  fireReadiness = null,
  env = process.env,
} = {}) {
  const enabled = boolEnv('LUNA_TECHNICAL_CHANGE_ENTRY_GATE_ENABLED', true, env);
  if (!enabled) return { ok: true, enabled: false, reason: 'technical_change_entry_gate_disabled' };

  const hardBlock = boolEnv('LUNA_TECHNICAL_CHANGE_ENTRY_HARD_BLOCK_ENABLED', true, env);
  const rsiOverbought = numEnv('LUNA_TECHNICAL_ENTRY_RSI_OVERBOUGHT', 70, env);
  const rsiOversold = numEnv('LUNA_TECHNICAL_ENTRY_RSI_OVERSOLD', 35, env);
  const bbUpper = numEnv('LUNA_TECHNICAL_ENTRY_BB_UPPER_POS', 0.85, env);
  const bbLower = numEnv('LUNA_TECHNICAL_ENTRY_BB_LOWER_POS', 0.2, env);
  const minVolumeConfirm = numEnv('LUNA_TECHNICAL_ENTRY_VOLUME_CONFIRM_MIN', 1.8, env);
  const triggerType = normalizeSetup(candidate?.triggerType || candidate?.trigger_type || context?.triggerType);
  const snapshot = resolveTechnicalEntrySnapshot({ candidate, event, chartGuard, fireReadiness, context });
  const confirmations = confirmationCount(snapshot);
  if (!snapshot.available) {
    return {
      ok: true,
      enabled: true,
      reason: 'technical_change_evidence_unavailable',
      evidence: snapshot,
      confirmations,
    };
  }

  const meanReversion = isMeanReversionSetup(candidate);
  const bearishPressure = snapshot.price != null
    && snapshot.sma20 != null
    && snapshot.price < snapshot.sma20
    && snapshot.macdHist != null
    && snapshot.macdHist < 0
    && snapshot.rsi != null
    && snapshot.rsi < 50;
  const lowerBandOrOversold = (snapshot.rsi != null && snapshot.rsi <= rsiOversold)
    || (snapshot.bbPos != null && snapshot.bbPos <= bbLower);
  const meanReversionRecovery = meanReversion
    && lowerBandOrOversold
    && (
      snapshot.macdHist > 0
      || (snapshot.price != null && snapshot.sma20 != null && snapshot.price >= snapshot.sma20)
      || snapshot.mtfBullish === true
    );
  const overbought = (snapshot.rsi != null && snapshot.rsi >= rsiOverbought)
    || (snapshot.bbPos != null && snapshot.bbPos >= bbUpper);
  const breakoutConfirmed = snapshot.mtfBullish === true
    && snapshot.volumeBurst != null
    && snapshot.volumeBurst >= minVolumeConfirm
    && (snapshot.breakoutRetest === true || triggerType.includes('breakout'));
  const blockers = [];
  const warnings = [];

  if (bearishPressure && meanReversion && !meanReversionRecovery) {
    blockers.push('technical_mean_reversion_recovery_missing');
  } else if (bearishPressure && !meanReversionRecovery) {
    blockers.push('technical_bearish_pressure_block');
  }
  if (overbought && !breakoutConfirmed) {
    blockers.push('technical_overbought_chase_block');
  }
  if (confirmations.available >= 3 && confirmations.passed < 2 && !meanReversionRecovery) {
    warnings.push('technical_bullish_confirmation_thin');
  }

  const blocked = blockers.length > 0 && hardBlock;
  return {
    ok: !blocked,
    enabled: true,
    reason: blocked ? blockers[0] : blockers.length > 0 ? 'technical_change_gate_shadow_block' : 'technical_change_gate_passed',
    blockers,
    warnings,
    hardBlock,
    wouldProbe: blockers.includes('technical_overbought_chase_block') || blockers.includes('technical_bearish_pressure_block'),
    evidence: {
      ...snapshot,
      price: round(snapshot.price),
      rsi: round(snapshot.rsi, 2),
      macdHist: round(snapshot.macdHist, 6),
      sma20: round(snapshot.sma20),
      sma50: round(snapshot.sma50),
      bbPos: round(snapshot.bbPos, 4),
      volumeBurst: round(snapshot.volumeBurst, 4),
    },
    confirmations,
  };
}

function getIndicatorFrame(analysisSummary = {}, interval = '4h') {
  const frames = [
    ...(Array.isArray(analysisSummary?.liveIndicatorFrames) ? analysisSummary.liveIndicatorFrames : []),
    ...(Array.isArray(analysisSummary?.liveIndicator?.timeframes) ? analysisSummary.liveIndicator.timeframes : []),
  ];
  return frames.find((frame) => String(frame?.interval || '').toLowerCase() === interval.toLowerCase()) || null;
}

function buildExitTechnicalState(analysisSummary = {}) {
  const intervals = ['1h', '4h', '1d'];
  const frames = intervals.map((interval) => {
    const frame = getIndicatorFrame(analysisSummary, interval) || {};
    return {
      interval,
      signal: normalizeSignal(frame.signal),
      rsi: getFirstNumber(frame.rsi, frame.rsi14),
      macdHist: getFirstNumber(frame.macdHist, frame.macd_hist),
      bbPos: normalizeBbPosition(frame.bbPct ?? frame.bb_pct ?? frame.bbPos),
    };
  });
  const compositeSignal = normalizeSignal(analysisSummary?.liveIndicator?.compositeSignal);
  const bearishFrames = frames.filter((frame) => frame.signal === 'SELL').length + (compositeSignal === 'SELL' ? 1 : 0);
  const recoverySignals = [
    frames.some((frame) => frame.signal === 'BUY'),
    frames.some((frame) => frame.rsi != null && frame.rsi >= 50),
    frames.some((frame) => frame.macdHist != null && frame.macdHist >= 0),
  ].filter(Boolean).length;
  const continuationSignals = [
    compositeSignal === 'BUY' || frames.some((frame) => frame.signal === 'BUY'),
    frames.some((frame) => frame.rsi != null && frame.rsi >= 52 && frame.rsi < 72),
    frames.some((frame) => frame.macdHist != null && frame.macdHist >= 0),
    frames.some((frame) => frame.bbPos != null && frame.bbPos >= 0.35 && frame.bbPos <= 0.85),
  ].filter(Boolean).length;
  return {
    compositeSignal,
    frames,
    bearishFrames,
    stackedBearish: bearishFrames >= 2,
    recoverySignals,
    continuationSignals,
  };
}

function isHardExitReason(reasonCode = '') {
  return HARD_EXIT_REASONS.has(String(reasonCode || ''));
}

export function applyTechnicalExitChangeReview(decision = {}, {
  pnlPct = 0,
  heldHours = 0,
  analysisSummary = {},
  dynamicTrail = null,
  env = process.env,
} = {}) {
  const enabled = boolEnv('LUNA_TECHNICAL_CHANGE_EXIT_REVIEW_ENABLED', true, env);
  const sourceDecision = decision && typeof decision === 'object' ? decision : {};
  const baseDecision = {
    ...sourceDecision,
    recommendation: String(sourceDecision?.recommendation || 'HOLD'),
    reasonCode: sourceDecision?.reasonCode || null,
    reason: sourceDecision?.reason || null,
  };
  if (!enabled) {
    return {
      decision: baseDecision,
      review: { enabled: false, reason: 'technical_change_exit_review_disabled' },
    };
  }

  const state = buildExitTechnicalState(analysisSummary);
  const normalizedPnl = finiteNumber(pnlPct, 0);
  const normalizedHeldHours = finiteNumber(heldHours, 0);
  const lossRecheckEnabled = boolEnv('LUNA_TECHNICAL_LOSS_EXIT_RECHECK_ENABLED', true, env);
  const profitTrailEnabled = boolEnv('LUNA_TECHNICAL_PROFIT_TRAILING_REVIEW_ENABLED', true, env);
  const profitTrailActionEnabled = boolEnv('LUNA_TECHNICAL_PROFIT_TRAILING_ACTION_ENABLED', true, env);
  const profitTrailThresholdPct = numEnv('LUNA_TECHNICAL_PROFIT_TRAILING_THRESHOLD_PCT', 8, env);
  const hardExit = isHardExitReason(baseDecision.reasonCode);
  const review = {
    enabled: true,
    originalRecommendation: baseDecision.recommendation,
    originalReasonCode: baseDecision.reasonCode,
    pnlPct: round(normalizedPnl),
    heldHours: round(normalizedHeldHours, 2),
    hardExit,
    state,
    dynamicTrailBreached: dynamicTrail?.breached === true,
    applied: false,
    reason: 'technical_change_review_noop',
  };

  if (
    lossRecheckEnabled
    && baseDecision.recommendation === 'EXIT'
    && normalizedPnl < 0
    && normalizedPnl > -5
    && !hardExit
    && state.recoverySignals >= 2
    && !state.stackedBearish
  ) {
    return {
      decision: {
        ...baseDecision,
        recommendation: 'HOLD',
        reasonCode: 'technical_loss_exit_recheck_hold',
        reason: `technical recovery ${state.recoverySignals}/3 with non-hard loss ${normalizedPnl.toFixed(2)}%; hold for one recheck`,
      },
      review: {
        ...review,
        applied: true,
        reason: 'loss_exit_recheck_hold',
      },
    };
  }

  if (
    profitTrailEnabled
    && baseDecision.recommendation === 'EXIT'
    && normalizedPnl > 0
    && !hardExit
    && state.continuationSignals >= 2
    && !state.stackedBearish
  ) {
    return {
      decision: {
        ...baseDecision,
        recommendation: 'ADJUST',
        reasonCode: 'technical_profit_exit_trailing_adjust',
        reason: `profit exit converted to partial/trailing adjust; continuation ${state.continuationSignals}/4, pnl ${normalizedPnl.toFixed(2)}%`,
      },
      review: {
        ...review,
        applied: true,
        reason: 'profit_exit_converted_to_trailing_adjust',
      },
    };
  }

  if (
    profitTrailEnabled
    && profitTrailActionEnabled
    && baseDecision.recommendation === 'HOLD'
    && normalizedPnl >= profitTrailThresholdPct
    && normalizedHeldHours >= 1
    && state.continuationSignals >= 2
    && !state.stackedBearish
  ) {
    return {
      decision: {
        ...baseDecision,
        recommendation: 'ADJUST',
        reasonCode: 'technical_profit_trailing_candidate',
        reason: `profit ${normalizedPnl.toFixed(2)}% with continuation ${state.continuationSignals}/4; prefer partial profit lock plus ATR trailing`,
      },
      review: {
        ...review,
        applied: true,
        reason: 'profit_trailing_candidate',
      },
    };
  }

  return { decision: baseDecision, review };
}

export default {
  resolveTechnicalEntrySnapshot,
  evaluateTechnicalEntryChangeGate,
  applyTechnicalExitChangeReview,
};
