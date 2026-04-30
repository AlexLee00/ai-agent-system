// @ts-nocheck
import { getMarketSnapshot } from './market-snapshot.ts';

export function kisOverseasSnapshot(args = {}) {
  return getMarketSnapshot({ ...args, market: 'kis_overseas', symbol: args.symbol || 'AAPL' });
}

