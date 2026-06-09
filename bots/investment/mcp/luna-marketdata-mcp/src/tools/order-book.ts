import { binanceOrderBook } from './binance-ws.ts';
import { simulatedFallbackOrBlock } from './live-fallback-policy.ts';
import { getOrderBook as getSimulatedOrderBook, normalizeMarket } from './market-snapshot.ts';

type OrderBookArgs = {
  market?: string;
  symbol?: string;
  [key: string]: unknown;
};

export async function getOrderBook(args: OrderBookArgs = {}) {
  const market = normalizeMarket(args.market || 'binance');
  if (market === 'binance') return binanceOrderBook(args);
  return simulatedFallbackOrBlock(() => ({
    ...getSimulatedOrderBook({ ...args, market }),
    providerMode: 'simulated_fallback',
    fallbackReason: 'order_book_real_provider_not_configured',
  }), { args, market, symbol: args.symbol || null, reason: 'order_book_real_provider_not_configured', tool: 'get_order_book' });
}

export { getSimulatedOrderBook };
