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
    blockers.push('domestic_defensive_rotation_validation_only');
    meta.domesticDefensiveRotation = {
      reason: 'domestic defensive_rotation closed winRate=10.7%, pnlNet=-889681 KRW',
    };
  }

  if (tradeMode === 'validation' && (regime.includes('bear') || regime.includes('ranging'))) {
    blockers.push('validation_regime_underperformance');
    meta.validationRegime = {
      reason: regime.includes('bear')
        ? 'trending_bear validation avgPnl=-7.68%'
        : 'ranging validation avgPnl=-2.13%',
    };
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
    if (guard.warnings.length === 0) return { decision, guard, changed: false };
    return {
      decision: {
        ...decision,
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
