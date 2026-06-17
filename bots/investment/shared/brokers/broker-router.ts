// @ts-nocheck

import { getTossCredentials } from '../secrets.ts';
import {
  assertExecutable,
  normalizeBrokerHorizon,
  normalizeBrokerMarket,
} from './broker-adapter.ts';
import { createKisBrokerAdapter, kisBrokerAdapter } from './kis-adapter.ts';
import { createTossBrokerAdapter, tossBrokerAdapter } from './toss-adapter.ts';

export function selectBroker({ horizon = null, market = 'domestic' } = {}) {
  const normalizedMarket = normalizeBrokerMarket(market);
  const credentials = getTossCredentials();
  const normalizedHorizon = normalizeBrokerHorizon(horizon || credentials.horizon || 'mid_long');
  const broker = normalizedMarket === 'crypto'
    ? 'binance'
    : normalizedHorizon === 'short'
      ? 'kis'
      : 'toss';
  return {
    broker,
    market: normalizedMarket,
    horizon: normalizedHorizon,
    mode: 'shadow_route_only',
    executable: false,
    reason: broker === 'kis'
      ? 'short_horizon_prefers_kis'
      : broker === 'toss'
        ? 'mid_long_horizon_prefers_toss'
        : 'crypto_market_keeps_existing_binance_path',
  };
}

export function createBrokerRouter(options: Record<string, any> = {}) {
  const adapters = {
    toss: options.tossAdapter || createTossBrokerAdapter(options.tossOptions || {}),
    kis: options.kisAdapter || createKisBrokerAdapter(options.kisOptions || {}),
  };

  function getBrokerAdapter(name = 'toss') {
    const key = String(name || '').trim().toLowerCase();
    if (key === 'toss') return adapters.toss;
    if (key === 'kis') return adapters.kis;
    throw new Error(`broker_adapter_not_available:${key || 'unknown'}`);
  }

  function getDataAdapter(market = 'domestic') {
    const normalizedMarket = normalizeBrokerMarket(market);
    const primary = adapters.toss;
    const fallback = adapters.kis;
    return {
      capabilities: {
        ...primary.capabilities,
        name: 'toss',
        canTrade: false,
        primary: 'toss',
        fallback: 'kis',
        market: normalizedMarket,
      },
      async getQuote(symbol: string, quoteMarket = normalizedMarket, quoteOptions = {}) {
        try {
          const quote = await primary.getQuote(symbol, quoteMarket, quoteOptions);
          if (quote?.price != null && Number(quote.price) > 0) return { ...quote, fallbackUsed: false };
          throw new Error('toss_quote_empty');
        } catch (error) {
          const quote = await fallback.getQuote(symbol, quoteMarket, quoteOptions);
          return { ...quote, fallbackUsed: true, fallbackReason: error instanceof Error ? error.message : String(error) };
        }
      },
      async getCandles(symbol: string, interval = '1d', range: any = null, candleOptions = {}) {
        try {
          const bars = await primary.getCandles(symbol, interval, range, { ...candleOptions, market: normalizedMarket });
          if (Array.isArray(bars) && bars.length > 0) return bars.map((bar) => ({ ...bar, fallbackUsed: false }));
          throw new Error('toss_candles_empty');
        } catch (error) {
          const bars = await fallback.getCandles(symbol, interval, range, { ...candleOptions, market: normalizedMarket });
          return bars.map((bar) => ({ ...bar, fallbackUsed: true, fallbackReason: error instanceof Error ? error.message : String(error) }));
        }
      },
      async getSecuritiesWarning(symbol: string, warningMarket = normalizedMarket, warningOptions = {}) {
        return primary.getSecuritiesWarning?.(symbol, warningMarket, warningOptions) || [];
      },
      async getMarketCalendar(calendarMarket = normalizedMarket, calendarOptions = {}) {
        return primary.getMarketCalendar?.(calendarMarket, calendarOptions) || null;
      },
      async getExchangeRate(rateOptions = {}) {
        return primary.getExchangeRate?.(rateOptions) || null;
      },
    };
  }

  return {
    adapters,
    selectBroker,
    getBrokerAdapter,
    getDataAdapter,
    assertExecutable,
  };
}

const defaultRouter = createBrokerRouter({ tossAdapter: tossBrokerAdapter, kisAdapter: kisBrokerAdapter });

export const getBrokerAdapter = (...args) => defaultRouter.getBrokerAdapter(...args);
export const getDataAdapter = (...args) => defaultRouter.getDataAdapter(...args);
export { assertExecutable };
