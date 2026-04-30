// @ts-nocheck
import { getMarketSnapshot } from './market-snapshot.ts';

export function tradingViewSnapshot(args = {}) {
  return getMarketSnapshot({ ...args, market: 'tradingview', symbol: args.symbol || 'BTCUSDT' });
}

