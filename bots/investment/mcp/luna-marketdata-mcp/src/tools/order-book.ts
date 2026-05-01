// @ts-nocheck
import { binanceOrderBook } from './binance-ws.ts';
import { getOrderBook as getSimulatedOrderBook, normalizeMarket } from './market-snapshot.ts';

export async function getOrderBook(args = {}) {
  const market = normalizeMarket(args.market || 'binance');
  if (market === 'binance') return binanceOrderBook(args);
  return {
    ...getSimulatedOrderBook({ ...args, market }),
    providerMode: 'simulated_fallback',
    fallbackReason: 'order_book_real_provider_not_configured',
  };
}

export { getSimulatedOrderBook };
