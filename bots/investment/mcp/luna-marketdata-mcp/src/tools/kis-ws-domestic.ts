// @ts-nocheck
import { getMarketSnapshot } from './market-snapshot.ts';

export function kisDomesticSnapshot(args = {}) {
  return getMarketSnapshot({ ...args, market: 'kis_domestic', symbol: args.symbol || '005930' });
}

