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
    minOrderAmount: 1,
    maxOrderAmount: 1_200,
    minOrderRatioOfAvailableFunds: 0.05,
    quantityMode: 'integer',
    allowFractional: false,
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

type MarketOrderExchange = keyof typeof MARKET_ORDER_RULES;

export function getMarketOrderRule(exchange: unknown) {
  return MARKET_ORDER_RULES[exchange as MarketOrderExchange] || null;
}

export function getMinOrderAmount(exchange: unknown) {
  return getMarketOrderRule(exchange)?.minOrderAmount ?? null;
}

export function getMaxOrderAmount(exchange: unknown) {
  return getMarketOrderRule(exchange)?.maxOrderAmount ?? null;
}

export function getMinOrderRatio(exchange: unknown) {
  return getMarketOrderRule(exchange)?.minOrderRatioOfAvailableFunds ?? 0.05;
}

export function allowsFractionalQuantity(exchange: unknown) {
  return Boolean(getMarketOrderRule(exchange)?.allowFractional);
}

export function requiresIntegerQuantity(exchange: unknown) {
  return getMarketOrderRule(exchange)?.quantityMode === 'integer';
}
