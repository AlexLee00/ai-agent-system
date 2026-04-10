export const MARKET_ORDER_RULES = Object.freeze({
  kis: Object.freeze({
    minOrderAmount: 200_000,
    maxOrderAmount: 1_200_000,
    minOrderRatioOfAvailableFunds: 0.05,
    quantityMode: 'integer',
    allowFractional: false,
    currency: 'KRW',
  }),
  kis_overseas: Object.freeze({
    minOrderAmount: 200,
    maxOrderAmount: 1_200,
    minOrderRatioOfAvailableFunds: 0.05,
    quantityMode: 'fractional_mock_only',
    allowFractional: true,
    currency: 'USD',
  }),
  binance: Object.freeze({
    minOrderAmount: 10,
    maxOrderAmount: null,
    minOrderRatioOfAvailableFunds: 0.05,
    quantityMode: 'fractional',
    allowFractional: true,
    currency: 'USDT',
  }),
});

export function getMarketOrderRule(exchange) {
  return MARKET_ORDER_RULES[exchange] || null;
}

export function getMinOrderAmount(exchange) {
  return getMarketOrderRule(exchange)?.minOrderAmount ?? null;
}

export function getMaxOrderAmount(exchange) {
  return getMarketOrderRule(exchange)?.maxOrderAmount ?? null;
}

export function getMinOrderRatio(exchange) {
  return getMarketOrderRule(exchange)?.minOrderRatioOfAvailableFunds ?? 0.05;
}

export function allowsFractionalQuantity(exchange) {
  return Boolean(getMarketOrderRule(exchange)?.allowFractional);
}

export function requiresIntegerQuantity(exchange) {
  return getMarketOrderRule(exchange)?.quantityMode === 'integer';
}
