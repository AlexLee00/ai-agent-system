// @ts-nocheck
/**
 * Guards derived from Luna's realized trade data.
 *
 * These rules intentionally stay deterministic and env-disableable so live
 * trading behavior can be audited without depending on the current DB state.
 */

const DISABLE_VALUES = new Set(['0', 'false', 'off', 'disabled']);

export const EXPECTED_SELL_NOOP_CODES = new Set([
  'missing_position',
  'partial_sell_below_minimum',
  'sell_amount_below_minimum',
  'no_free_balance_for_sell',
  'broker_position_missing',
  'invalid_sell_quantity',
]);

export const TRADE_DATA_WEAK_SYMBOLS = Object.freeze({
  'CRYPTO:OPN/USDT': { reason: 'closed>=14, winRate=0%, avgPnl=-29.18%' },
  'CRYPTO:SIGN/USDT': { reason: 'closed=6, winRate=0%, avgPnl=-14.54%' },
  'CRYPTO:KITE/USDT': { reason: 'closed=17, avgPnl=-13.48%' },
  'CRYPTO:KAT/USDT': { reason: 'closed=10, avgPnl=-8.77%' },
  'CRYPTO:SAHARA/USDT': { reason: 'closed=14, avgPnl=-3.43%' },
  'DOMESTIC:006340': { reason: 'closed=6, winRate=0%, avgPnl=-11.48%' },
  'OVERSEAS:POET': { reason: 'closed=3, avgPnl=-15.11%; require cooldown/probe-only evidence before re-entry' },
});

export function isTradeDataGuardEnabled(env = process.env) {
  return !DISABLE_VALUES.has(String(env.LUNA_TRADE_DATA_DERIVED_GUARDS || '').trim().toLowerCase());
}

export function normalizeTradeDataMarket(market = '') {
  const value = String(market || '').trim().toLowerCase();
  if (value === 'binance' || value === 'crypto') return 'crypto';
  if (value === 'kis' || value === 'domestic') return 'domestic';
  if (value === 'kis_overseas' || value === 'overseas') return 'overseas';
  return value || 'unknown';
}

export function resolveExpectedSellNoopStatus({ action = null, code = null, status = null } = {}) {
  const normalizedAction = String(action || '').toUpperCase();
  const normalizedCode = String(code || '').trim();
  if (normalizedAction === 'SELL' && EXPECTED_SELL_NOOP_CODES.has(normalizedCode)) {
    return {
      status: 'skipped_below_min',
      classification: normalizedCode === 'missing_position' || normalizedCode === 'broker_position_missing'
        ? 'no_position_noop'
        : 'below_minimum_noop',
      reasonCode: normalizedCode,
    };
  }
  return {
    status: status || null,
    classification: null,
    reasonCode: normalizedCode || null,
  };
}

export function checkTradeDataWeakSymbol(symbol, market, env = process.env) {
  if (!isTradeDataGuardEnabled(env)) {
    return { blocked: false, source: null, reason: null, key: null };
  }
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const normalizedMarket = normalizeTradeDataMarket(market).toUpperCase();
  if (!normalizedSymbol) return { blocked: false, source: null, reason: null, key: null };

  const keys = [
    `${normalizedMarket}:${normalizedSymbol}`,
    normalizedSymbol,
  ];
  const key = keys.find((item) => TRADE_DATA_WEAK_SYMBOLS[item]);
  if (!key) return { blocked: false, source: null, reason: null, key: null };
  const row = TRADE_DATA_WEAK_SYMBOLS[key];
  return {
    blocked: true,
    source: 'pre_entry/trade_data_weak_symbol',
    reason: `[trade-data] ${normalizedSymbol} cooldown: ${row.reason}`,
    key,
  };
}

function clamp01(value, fallback = 1) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(0, Math.min(1, numberValue));
}

function applySizingAdjustment(meta, {
  code,
  multiplier,
  reason,
} = {}) {
  if (!code || !(Number(multiplier) > 0)) return;
  const next = {
    code,
    multiplier: clamp01(multiplier, 1),
    reason: reason || code,
  };
  meta.sizingAdjustments = Array.isArray(meta.sizingAdjustments)
    ? [...meta.sizingAdjustments, next]
    : [next];
  const current = Number(meta.sizingMultiplier ?? 1);
  meta.sizingMultiplier = Number((Math.min(Number.isFinite(current) ? current : 1, next.multiplier)).toFixed(4));
}

export function evaluateLearningTradeQuality(row = {}) {
  const reasons = [];
  const status = String(row.status || '').toLowerCase();
  const closed = status === 'closed' || row.exit_time != null || row.exitTime != null;
  const rawPnl = Number(row.pnl_percent ?? row.pnlPercent);
  const tpSlSet = row.tp_sl_set === true || row.tpSlSet === true;
  const excluded = row.exclude_from_learning === true || row.excludeFromLearning === true;
  const qualityFlag = String(row.quality_flag || row.qualityFlag || '').toLowerCase();

  if (excluded || qualityFlag === 'exclude_from_learning') reasons.push('explicitly_excluded_from_learning');
  if (!closed) reasons.push('trade_not_closed');
  if (!Number.isFinite(rawPnl) || Math.abs(rawPnl) > 1000) reasons.push('pnl_percent_outlier_or_missing');
  if (!tpSlSet) reasons.push('tp_sl_not_set');

  return {
    trusted: reasons.length === 0,
    excludeFromLearning: reasons.length > 0,
    reasons,
    qualityFlag: reasons.length > 0 ? 'low_trust_trade_data' : 'trusted',
  };
}

export function evaluateTradeDataEntryGuard(signal = {}, env = process.env) {
  if (!isTradeDataGuardEnabled(env)) {
    return { blocked: false, blockers: [], warnings: [], meta: {} };
  }
  const action = String(signal.action || '').toUpperCase();
  if (action !== 'BUY') return { blocked: false, blockers: [], warnings: [], meta: {} };

  const market = normalizeTradeDataMarket(signal.market || signal.exchange);
  const strategyFamily = String(
    signal.strategy_family
      || signal.strategyFamily
      || signal.strategy_route?.selectedFamily
      || signal.strategyRoute?.selectedFamily
      || signal.setup_type
      || '',
  ).toLowerCase();
  const tradeMode = String(signal.trade_mode || signal.tradeMode || '').toLowerCase();
  const regime = String(signal.marketRegime || signal.regime || signal.market_regime || '').toLowerCase();
  const blockers = [];
  const warnings = [];
  const meta = { market, strategyFamily: strategyFamily || null, tradeMode: tradeMode || null, regime: regime || null };

  const weak = checkTradeDataWeakSymbol(signal.symbol, market, env);
  if (weak.blocked) {
    blockers.push('trade_data_weak_symbol');
    meta.weakSymbol = weak;
  }

  if (market === 'domestic' && strategyFamily === 'defensive_rotation') {
    warnings.push('domestic_defensive_rotation_probe_only');
    meta.domesticDefensiveRotation = {
      reason: 'domestic defensive_rotation closed winRate=10.7%, pnlNet=-889681 KRW',
    };
    applySizingAdjustment(meta, {
      code: 'domestic_defensive_rotation_probe_only',
      multiplier: 0.25,
      reason: 'defensive_rotation은 국내장 과거 성과가 약해 차단 대신 25% probe sizing으로 축소',
    });
  }

  if (market === 'domestic' && strategyFamily === 'mean_reversion') {
    warnings.push('domestic_mean_reversion_probe_only');
    meta.domesticMeanReversion = {
      reason: 'domestic mean_reversion closed winRate=0%, avgPnl=-6.37%',
    };
    applySizingAdjustment(meta, {
      code: 'domestic_mean_reversion_probe_only',
      multiplier: 0.35,
      reason: 'mean_reversion은 국내장 샘플이 약해 35% probe sizing으로 축소',
    });
  }

  if (tradeMode === 'validation' && (regime.includes('bear') || regime.includes('ranging'))) {
    warnings.push('validation_regime_probe_only');
    meta.validationRegime = {
      reason: regime.includes('bear')
        ? 'trending_bear validation avgPnl=-7.68%'
        : 'ranging validation avgPnl=-2.13%',
    };
    applySizingAdjustment(meta, {
      code: 'validation_regime_probe_only',
      multiplier: regime.includes('bear') ? 0.25 : 0.4,
      reason: '약세/횡보 검증 구간은 데이터 축적을 위해 probe sizing으로 축소',
    });
  }

  if (market === 'overseas') {
    warnings.push('overseas_sample_cap_required');
    meta.overseas = {
      reason: 'overseas sample is small and avgPnl=-9.63%; keep capped until >=30 closed outcomes',
    };
  }

  return {
    blocked: blockers.length > 0,
    blockers,
    warnings,
    meta,
  };
}

export function applyTradeDataEntryGuardToDecision(decision = {}, exchange = null, env = process.env) {
  const guard = evaluateTradeDataEntryGuard({
    ...decision,
    exchange,
    market: decision.market || exchange,
  }, env);
  if (!guard.blocked) {
    const sizingMultiplier = Number(guard?.meta?.sizingMultiplier ?? 1);
    const shouldResize = Number.isFinite(sizingMultiplier) && sizingMultiplier > 0 && sizingMultiplier < 1 && Number(decision.amount_usdt || 0) > 0;
    if (guard.warnings.length === 0 && !shouldResize) return { decision, guard, changed: false };
    const adjustedAmount = shouldResize
      ? Number((Number(decision.amount_usdt || 0) * sizingMultiplier).toFixed(4))
      : decision.amount_usdt;
    return {
      decision: {
        ...decision,
        amount_usdt: adjustedAmount,
        confidence: shouldResize
          ? Math.max(0, Number(decision.confidence || 0) - 0.03)
          : decision.confidence,
        reasoning: shouldResize
          ? `${decision.reasoning || ''} | trade_data_probe_sizing(${sizingMultiplier})`.slice(0, 220)
          : decision.reasoning,
        block_meta: {
          ...(decision.block_meta || {}),
          trade_data_guard: guard,
        },
      },
      guard,
      changed: true,
    };
  }

  return {
    decision: {
      ...decision,
      action: 'HOLD',
      amount_usdt: 0,
      confidence: Math.max(0, Number(decision.confidence || 0) - 0.15),
      reasoning: `trade_data_entry_guard_blocked: ${guard.blockers.join(',')} | ${decision.reasoning || ''}`.slice(0, 220),
      block_meta: {
        ...(decision.block_meta || {}),
        trade_data_guard: guard,
      },
    },
    guard,
    changed: true,
  };
}

export default {
  EXPECTED_SELL_NOOP_CODES,
  TRADE_DATA_WEAK_SYMBOLS,
  isTradeDataGuardEnabled,
  normalizeTradeDataMarket,
  resolveExpectedSellNoopStatus,
  checkTradeDataWeakSymbol,
  evaluateTradeDataEntryGuard,
  applyTradeDataEntryGuardToDecision,
};
