// @ts-nocheck

import {
  getDomesticBalance,
  getDomesticDailyPriceBars,
  getDomesticQuoteSnapshot,
  getOverseasBalance,
  getOverseasDailyPriceBars,
  getOverseasQuoteSnapshot,
} from '../kis-client.ts';
import {
  createExecutionDisabledMethod,
  normalizeBrokerMarket,
  normalizeBrokerSymbol,
} from './broker-adapter.ts';

const KIS_CAPABILITY = Object.freeze({
  name: 'kis',
  canTrade: false,
  hasSecuritiesWarning: false,
  hasSandbox: true,
  markets: ['domestic', 'overseas'],
});

function quoteFromKis(row: any, market: string, symbol: string) {
  if (!row) return null;
  return {
    provider: 'kis',
    symbol: normalizeBrokerSymbol(row.symbol || symbol),
    market,
    price: Number.isFinite(Number(row.price)) ? Number(row.price) : null,
    currency: market === 'domestic' ? 'KRW' : 'USD',
    timestamp: row.timestamp || null,
    volume: Number.isFinite(Number(row.volume)) ? Number(row.volume) : null,
    raw: row,
  };
}

function barsFromKis(rows: any[] = [], market: string, symbol: string) {
  return (Array.isArray(rows) ? rows : []).map((bar) => ({
    provider: 'kis',
    symbol: normalizeBrokerSymbol(symbol),
    market,
    timestamp: bar.timestamp || bar.date || null,
    date: bar.date || null,
    open: Number.isFinite(Number(bar.open)) ? Number(bar.open) : null,
    high: Number.isFinite(Number(bar.high)) ? Number(bar.high) : null,
    low: Number.isFinite(Number(bar.low)) ? Number(bar.low) : null,
    close: Number.isFinite(Number(bar.close)) ? Number(bar.close) : null,
    volume: Number.isFinite(Number(bar.volume)) ? Number(bar.volume) : null,
    raw: bar.raw ?? bar,
  }));
}

export function createKisBrokerAdapter(options: Record<string, any> = {}) {
  const kisClient = options.kisClient || {
    getDomesticBalance,
    getDomesticDailyPriceBars,
    getDomesticQuoteSnapshot,
    getOverseasBalance,
    getOverseasDailyPriceBars,
    getOverseasQuoteSnapshot,
  };
  const disabled = createExecutionDisabledMethod('kis');

  return {
    capabilities: KIS_CAPABILITY,
    async getQuote(symbol: string, market = 'domestic', quoteOptions = {}) {
      const normalizedMarket = normalizeBrokerMarket(market || symbol);
      const normalizedSymbol = normalizeBrokerSymbol(symbol);
      const snapshot = normalizedMarket === 'domestic'
        ? await kisClient.getDomesticQuoteSnapshot(normalizedSymbol, quoteOptions.paper)
        : await kisClient.getOverseasQuoteSnapshot(normalizedSymbol, quoteOptions);
      return quoteFromKis(snapshot, normalizedMarket, normalizedSymbol);
    },
    async getCandles(symbol: string, interval = '1d', range: any = null, candleOptions = {}) {
      const normalizedSymbol = normalizeBrokerSymbol(symbol);
      const optionsForClient = {
        ...(typeof range === 'object' && range !== null ? range : {}),
        ...candleOptions,
      };
      if (range && typeof range !== 'object') optionsForClient.days = Number(range) || range;
      const normalizedMarket = normalizeBrokerMarket(candleOptions.market || symbol);
      const bars = normalizedMarket === 'domestic'
        ? await kisClient.getDomesticDailyPriceBars(normalizedSymbol, optionsForClient)
        : await kisClient.getOverseasDailyPriceBars(normalizedSymbol, optionsForClient);
      return barsFromKis(bars, normalizedMarket, normalizedSymbol);
    },
    async getHoldings(market = 'domestic', holdingOptions = {}) {
      const normalizedMarket = normalizeBrokerMarket(market);
      return normalizedMarket === 'domestic'
        ? kisClient.getDomesticBalance(holdingOptions.paper)
        : kisClient.getOverseasBalance(holdingOptions.paper);
    },
    placeOrder: disabled,
    amendOrder: disabled,
    cancelOrder: disabled,
  };
}

export const kisBrokerAdapter = createKisBrokerAdapter();
