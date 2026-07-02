// @ts-nocheck

import {
  createExecutionDisabledMethod,
  normalizeBrokerMarket,
  normalizeBrokerSymbol,
} from './broker-adapter.ts';
import { createTossClient, tossCapability } from './toss-client.ts';

function normalizeTossQuote(quote: any, market: string) {
  if (!quote) return null;
  return {
    provider: 'toss',
    symbol: normalizeBrokerSymbol(quote.symbol),
    market: quote.market || normalizeBrokerMarket(market),
    price: Number.isFinite(Number(quote.price)) ? Number(quote.price) : null,
    currency: quote.currency || null,
    timestamp: quote.timestamp || null,
    raw: quote.raw ?? quote,
  };
}

function normalizeTossBars(response: any) {
  const rows = Array.isArray(response) ? response : response?.candles;
  return (Array.isArray(rows) ? rows : []).map((bar) => ({
    provider: 'toss',
    symbol: normalizeBrokerSymbol(bar.symbol || response?.symbol),
    market: bar.market || normalizeBrokerMarket(bar.market || response?.market || response?.symbol),
    timestamp: bar.timestamp || bar.date || null,
    open: Number.isFinite(Number(bar.open)) ? Number(bar.open) : null,
    high: Number.isFinite(Number(bar.high)) ? Number(bar.high) : null,
    low: Number.isFinite(Number(bar.low)) ? Number(bar.low) : null,
    close: Number.isFinite(Number(bar.close)) ? Number(bar.close) : null,
    volume: Number.isFinite(Number(bar.volume)) ? Number(bar.volume) : null,
    currency: bar.currency || null,
    raw: bar.raw ?? bar,
  }));
}

export function createTossBrokerAdapter(options: Record<string, any> = {}) {
  const client = options.client || createTossClient(options.clientOptions || {});
  const capabilities = {
    ...tossCapability,
    name: 'toss',
    canTrade: false,
    markets: ['domestic', 'overseas'],
  };
  const disabled = createExecutionDisabledMethod('toss');

  return {
    capabilities,
    async getQuote(symbol: string, market = '', quoteOptions = {}) {
      const quote = await client.getPrice(normalizeBrokerSymbol(symbol), quoteOptions);
      return normalizeTossQuote(quote, market || symbol);
    },
    async getCandles(symbol: string, interval = '1d', range: any = null, candleOptions = {}) {
      const optionsForClient = {
        ...(typeof range === 'object' && range !== null ? range : {}),
        ...candleOptions,
      };
      if (range && typeof range !== 'object') optionsForClient.range = range;
      const response = await client.getCandles(normalizeBrokerSymbol(symbol), interval, optionsForClient);
      return normalizeTossBars(response);
    },
    async getSecuritiesWarning(symbol: string) {
      return client.getSecuritiesWarning(normalizeBrokerSymbol(symbol));
    },
    async getSecuritiesWarningsForUniverse(symbols = [], warningOptions = {}) {
      return client.getSecuritiesWarningsForUniverse(symbols, warningOptions);
    },
    async getOrderBook(symbol: string, orderBookOptions = {}) {
      return client.getOrderBook(normalizeBrokerSymbol(symbol), orderBookOptions);
    },
    async getTrades(symbol: string, tradeOptions = {}) {
      return client.getTrades(normalizeBrokerSymbol(symbol), tradeOptions);
    },
    async getStockMaster(symbol: string, masterOptions = {}) {
      return client.getStockMaster(normalizeBrokerSymbol(symbol), masterOptions);
    },
    async getMarketCalendar(market = 'domestic', calendarOptions = {}) {
      return client.getMarketCalendar(normalizeBrokerMarket(market), calendarOptions);
    },
    async getExchangeRate(rateOptions = {}) {
      return client.getExchangeRate(rateOptions);
    },
    async getHoldings(market = 'domestic', holdingOptions = {}) {
      return client.getHoldings(normalizeBrokerMarket(market), holdingOptions);
    },
    async getBuyingPower(powerOptions = {}) {
      return client.getBuyingPower(powerOptions);
    },
    async getSellable(symbol: string, sellableOptions = {}) {
      return client.getSellableQuantity(normalizeBrokerSymbol(symbol), sellableOptions);
    },
    async getSellableQuantity(symbol: string, sellableOptions = {}) {
      return client.getSellableQuantity(normalizeBrokerSymbol(symbol), sellableOptions);
    },
    async getCommission(commissionOptions = {}) {
      return client.getCommissions(commissionOptions);
    },
    async getCommissions(commissionOptions = {}) {
      return client.getCommissions(commissionOptions);
    },
    placeOrder: disabled,
    amendOrder: disabled,
    cancelOrder: disabled,
  };
}

export const tossBrokerAdapter = createTossBrokerAdapter();
