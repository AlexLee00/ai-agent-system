// @ts-nocheck
import { getMarketSnapshot, getOrderBook } from './market-snapshot.ts';

export function binanceSnapshot(args = {}) {
  return getMarketSnapshot({ ...args, market: args.market || 'binance' });
}

export function binanceOrderBook(args = {}) {
  return getOrderBook({ ...args, market: args.market || 'binance' });
}

