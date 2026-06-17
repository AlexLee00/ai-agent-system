// @ts-nocheck

export type BrokerName = 'toss' | 'kis' | 'binance';
export type BrokerMarket = 'domestic' | 'overseas' | 'crypto';
export type BrokerHorizon = 'short' | 'mid' | 'long' | 'mid_long';

export type BrokerCapabilities = {
  name: BrokerName;
  canTrade: boolean;
  hasSecuritiesWarning: boolean;
  hasSandbox: boolean;
  markets: BrokerMarket[];
  [key: string]: unknown;
};

export type Quote = {
  provider: string;
  symbol: string;
  market: BrokerMarket | string;
  price: number | null;
  currency?: string | null;
  timestamp?: string | number | null;
  raw?: unknown;
  [key: string]: unknown;
};

export type Bar = {
  provider?: string;
  symbol?: string;
  market?: BrokerMarket | string;
  timestamp?: string | number | null;
  date?: string | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume?: number | null;
  raw?: unknown;
  [key: string]: unknown;
};

export type BrokerAdapter = {
  readonly capabilities: BrokerCapabilities;
  getQuote(symbol: string, market?: BrokerMarket | string, options?: Record<string, unknown>): Promise<Quote | null>;
  getCandles(symbol: string, interval?: string, range?: unknown, options?: Record<string, unknown>): Promise<Bar[]>;
  getHoldings?: (market?: BrokerMarket | string, options?: Record<string, unknown>) => Promise<unknown>;
  getSecuritiesWarning?: (symbol: string, market?: BrokerMarket | string, options?: Record<string, unknown>) => Promise<unknown>;
  getMarketCalendar?: (market?: BrokerMarket | string, options?: Record<string, unknown>) => Promise<unknown>;
  getExchangeRate?: (options?: Record<string, unknown>) => Promise<unknown>;
  getBuyingPower?: (...args: unknown[]) => Promise<unknown>;
  getSellable?: (...args: unknown[]) => Promise<unknown>;
  getCommission?: (...args: unknown[]) => Promise<unknown>;
  placeOrder?: (...args: unknown[]) => Promise<never>;
  amendOrder?: (...args: unknown[]) => Promise<never>;
  cancelOrder?: (...args: unknown[]) => Promise<never>;
  [key: string]: unknown;
};

export function normalizeBrokerMarket(market: unknown = 'domestic'): BrokerMarket {
  const key = String(market || '').trim().toLowerCase();
  if (key === 'kis_domestic' || key === 'kr' || key === 'korea' || key === 'domestic') return 'domestic';
  if (key === 'kis_overseas' || key === 'us' || key === 'usa' || key === 'overseas') return 'overseas';
  if (key === 'binance' || key === 'crypto') return 'crypto';
  return /^[0-9]{6}$/.test(key) ? 'domestic' : 'overseas';
}

export function normalizeBrokerHorizon(horizon: unknown = 'mid_long'): BrokerHorizon {
  const key = String(horizon || '').trim().toLowerCase();
  if (key === 'short') return 'short';
  if (key === 'mid') return 'mid';
  if (key === 'long') return 'long';
  if (key === 'mid_long' || key === 'mid-long' || key === 'medium_long') return 'mid_long';
  return 'mid_long';
}

export function normalizeBrokerSymbol(symbol: unknown): string {
  return String(symbol || '').trim().toUpperCase();
}

export function createExecutionDisabledError(adapterName: unknown, reason = 'broker_execution_disabled_shadow') {
  const error = new Error(`${reason}:${String(adapterName || 'unknown')}`);
  error.code = reason;
  error.adapter = String(adapterName || 'unknown');
  return error;
}

export function createExecutionDisabledMethod(adapterName: unknown) {
  return async () => {
    throw createExecutionDisabledError(adapterName);
  };
}

export function assertExecutable(adapter: BrokerAdapter, options: Record<string, unknown> = {}) {
  const capability = adapter?.capabilities || {};
  const promotionApproved = options.promotionApproved === true || process.env.LUNA_TOSS_PROMOTION_APPROVED === 'true';
  const liveTrading = options.liveTrading === true;
  if (capability.canTrade !== true || liveTrading !== true || promotionApproved !== true) {
    throw createExecutionDisabledError(capability.name || 'unknown');
  }
  return true;
}
