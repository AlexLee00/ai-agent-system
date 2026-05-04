function bool(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

export function isStrictRealMarketDataRequired(args = {}) {
  if (args.allowSimulatedFallback === true) return false;
  if (bool(process.env.LUNA_MARKETDATA_ALLOW_SIMULATED_FALLBACK_IN_LIVE)) return false;
  return args.requireReal === true
    || args.liveFire === true
    || bool(process.env.LUNA_LIVE_FIRE_ENABLED)
    || bool(process.env.LUNA_MARKETDATA_REQUIRE_REAL);
}

export function blockSimulatedMarketDataFallback({ args = {}, market = 'unknown', symbol = null, reason = 'real_marketdata_unavailable', tool = 'marketdata' } = {}) {
  return {
    ok: false,
    source: 'luna-marketdata-mcp',
    providerMode: 'real_required',
    market,
    symbol: symbol || args.symbol || null,
    error: 'marketdata_simulated_fallback_blocked',
    fallbackReason: String(reason || 'real_marketdata_unavailable').slice(0, 240),
    tool,
    strictRealMarketDataRequired: true,
    safetyBoundary: {
      liveFire: args.liveFire === true || bool(process.env.LUNA_LIVE_FIRE_ENABLED),
      requireReal: args.requireReal === true || bool(process.env.LUNA_MARKETDATA_REQUIRE_REAL),
      allowSimulatedFallback: false,
    },
    checkedAt: new Date().toISOString(),
  };
}

export function simulatedFallbackOrBlock(builder, options = {}) {
  if (isStrictRealMarketDataRequired(options.args || {})) return blockSimulatedMarketDataFallback(options);
  return builder();
}
