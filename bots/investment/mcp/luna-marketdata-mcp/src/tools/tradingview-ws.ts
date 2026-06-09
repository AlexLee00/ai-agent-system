import { getMarketSnapshot } from './market-snapshot.ts';
import { isStrictRealMarketDataRequired, simulatedFallbackOrBlock } from './live-fallback-policy.ts';

const DEFAULT_TIMEOUT_MS = Number(process.env.LUNA_MARKETDATA_REAL_TIMEOUT_MS || 5000);
const DEFAULT_TV_WS_URL = `ws://127.0.0.1:${process.env.TV_WS_PORT || 8082}`;
const DEFAULT_TV_HTTP_URL = `http://127.0.0.1:${process.env.TV_METRICS_PORT || 8083}`;
type TradingViewArgs = {
  symbol?: string;
  timeframe?: string;
  disableReal?: boolean;
  httpBase?: string;
  wsUrl?: string;
  timeoutMs?: number;
  requireTradingViewRealtime?: boolean;
  [key: string]: unknown;
};
type TradingViewBar = {
  symbol?: string;
  timeframe?: string;
  close?: number;
  price?: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  timestamp?: number | string;
};
type TradingViewSnapshot = {
  ok: boolean;
  source?: string;
  providerMode?: string;
  fallbackReason?: string | null;
  market?: string;
  symbol?: string;
  timeframe?: string;
  price?: number;
  open?: number;
  high?: number;
  low?: number;
  volume24h?: number;
  ageMs?: number | null;
  stale?: boolean;
  exchangeEventAt?: string | null;
  fetchedAt?: string;
  [key: string]: unknown;
};
type WsLike = {
  addEventListener?: (event: string, handler: (event: any) => void) => void;
  on?: (event: string, handler: (event: any) => void) => void;
  send: (payload: string) => void;
  close?: () => void;
};
type SubscriptionEntry = {
  ws: WsLike;
  key: string;
  symbol: string;
  timeframe: string;
  status: string;
  lastSnapshot: TradingViewSnapshot | null;
  openedAt: string;
  lastError?: string;
};
const subscriptions = new Map<string, SubscriptionEntry>();

function isRealEnabled(args: TradingViewArgs = {}) {
  if (args.disableReal === true) return false;
  return process.env.LUNA_MARKETDATA_REAL_WS_ENABLED !== 'false';
}

function normalizeSymbol(symbol: unknown = 'BINANCE:BTCUSDT') {
  const text = String(symbol || 'BINANCE:BTCUSDT').trim().toUpperCase();
  if (text.includes(':')) return text;
  if (text.includes('/')) return `BINANCE:${text.replace('/', '')}`;
  return text;
}

export function normalizeTradingViewTimeframe(timeframe = '60') {
  const text = String(timeframe || '60').trim().toLowerCase();
  const map: Record<string, string> = {
    '1m': '1',
    '3m': '3',
    '5m': '5',
    '15m': '15',
    '30m': '30',
    '60m': '60',
    '1h': '60',
    '2h': '120',
    '4h': '240',
    '1d': 'D',
    d: 'D',
    day: 'D',
    '1w': 'W',
    w: 'W',
    week: 'W',
  };
  return map[text] || String(timeframe || '60').trim() || '60';
}

function fallbackSnapshot(args: TradingViewArgs = {}, reason: unknown = 'tradingview_realtime_unavailable') {
  return simulatedFallbackOrBlock(() => ({
    ...getMarketSnapshot({ ...args, market: 'tradingview', symbol: String(args.symbol || 'BINANCE:BTCUSDT') }),
    providerMode: 'simulated_fallback',
    fallbackReason: String(reason || 'tradingview_realtime_unavailable').slice(0, 240),
  }), { args, market: 'tradingview', symbol: String(args.symbol || 'BINANCE:BTCUSDT'), reason: String(reason || ''), tool: 'get_market_snapshot' }) as TradingViewSnapshot;
}

function addWsListener(ws: WsLike, event: string, handler: (event: any) => void) {
  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener(event, handler);
    return;
  }
  if (typeof ws.on === 'function') ws.on(event, handler);
}

function messageText(eventOrRaw: any): string {
  const raw = eventOrRaw?.data ?? eventOrRaw;
  if (typeof raw === 'string') return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  return String(raw || '');
}

function snapshotFromBar(symbol: string, timeframe: string, bar: TradingViewBar = {}, meta: TradingViewSnapshot = {} as TradingViewSnapshot): TradingViewSnapshot {
  const price = Number(bar.close || bar.price || 0);
  return {
    ok: price > 0,
    source: meta.source || 'tradingview_ws_service',
    providerMode: meta.providerMode || 'websocket',
    fallbackReason: meta.fallbackReason || null,
    market: 'tradingview',
    symbol: normalizeSymbol(symbol),
    timeframe: normalizeTradingViewTimeframe(timeframe),
    price,
    open: Number(bar.open || 0),
    high: Number(bar.high || 0),
    low: Number(bar.low || 0),
    volume24h: Number(bar.volume || 0),
    ageMs: Number.isFinite(Number(meta.ageMs)) ? Number(meta.ageMs) : null,
    stale: false,
    exchangeEventAt: bar.timestamp ? new Date(Number(bar.timestamp)).toISOString() : null,
    fetchedAt: new Date().toISOString(),
  };
}

export function isTradingViewPayloadForRequest(payload: { symbol?: string; timeframe?: string; bar?: TradingViewBar } = {}, symbol = 'BINANCE:BTCUSDT', timeframe = '60') {
  const expectedSymbol = normalizeSymbol(symbol);
  const expectedTimeframe = normalizeTradingViewTimeframe(timeframe);
  const actualSymbol = normalizeSymbol(payload.symbol || payload.bar?.symbol || '');
  const actualTimeframe = normalizeTradingViewTimeframe(payload.timeframe || payload.bar?.timeframe || '');
  return actualSymbol === expectedSymbol && actualTimeframe === expectedTimeframe;
}

async function latestFromHttp(args: TradingViewArgs = {}): Promise<TradingViewSnapshot> {
  const symbol = normalizeSymbol(args.symbol || 'BINANCE:BTCUSDT');
  const timeframe = normalizeTradingViewTimeframe(args.timeframe || '60');
  const base = String(args.httpBase || DEFAULT_TV_HTTP_URL).replace(/\/$/, '');
  const requireReal = isStrictRealMarketDataRequired(args) || args.requireTradingViewRealtime === true;
  const subscribeUrl = `${base}/subscribe?symbol=${encodeURIComponent(symbol)}&timeframe=${encodeURIComponent(timeframe)}`;
  await fetch(subscribeUrl, { signal: AbortSignal.timeout(Math.max(250, Number(args.timeoutMs || DEFAULT_TIMEOUT_MS))) }).catch(() => null);
  const latestUrl = `${base}/latest?symbols=${encodeURIComponent(symbol)}&timeframes=${encodeURIComponent(timeframe)}${requireReal ? '&requireReal=true' : ''}`;
  const response = await fetch(latestUrl, { signal: AbortSignal.timeout(Math.max(250, Number(args.timeoutMs || DEFAULT_TIMEOUT_MS))) });
  if (!response.ok) throw new Error(`tradingview_latest_http_${response.status}`);
  const body: any = await response.json();
  const row = body?.bars?.[0];
  if (!row?.bar) throw new Error('tradingview_latest_empty');
  if (!isTradingViewPayloadForRequest(row, symbol, timeframe)) throw new Error('tradingview_latest_symbol_mismatch');
  const snapshot = snapshotFromBar(symbol, timeframe, row.bar, row);
  if (requireReal && !isTradingViewRealtimeSnapshot(snapshot)) throw new Error('tradingview_realtime_required');
  return snapshot;
}

function isTradingViewRealtimeSnapshot(snapshot: TradingViewSnapshot = {} as TradingViewSnapshot) {
  const source = String(snapshot.source || '').toLowerCase();
  const providerMode = String(snapshot.providerMode || '').toLowerCase();
  return snapshot.ok === true
    && source === 'tradingview_ws_service'
    && providerMode.includes('websocket')
    && !snapshot.fallbackReason;
}

async function wsSnapshot(args: TradingViewArgs = {}): Promise<TradingViewSnapshot | null> {
  if (typeof globalThis.WebSocket !== 'function') throw new Error('native_websocket_unavailable');
  const symbol = normalizeSymbol(args.symbol || 'BINANCE:BTCUSDT');
  const timeframe = normalizeTradingViewTimeframe(args.timeframe || '60');
  const key = `${symbol}:${timeframe}`;
  const existing = subscriptions.get(key);
  if (existing?.lastSnapshot?.ok) return existing.lastSnapshot;

  const ws = new globalThis.WebSocket(args.wsUrl || DEFAULT_TV_WS_URL) as WsLike;
  const entry: SubscriptionEntry = { ws, key, symbol, timeframe, status: 'connecting', lastSnapshot: null, openedAt: new Date().toISOString() };
  subscriptions.set(key, entry);

  await new Promise<TradingViewSnapshot | void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (entry.lastSnapshot?.ok) resolve(entry.lastSnapshot);
      else reject(new Error('tradingview_ws_snapshot_timeout'));
    }, Math.max(250, Number(args.timeoutMs || DEFAULT_TIMEOUT_MS)));

    addWsListener(ws, 'open', () => {
      entry.status = 'open';
      ws.send(JSON.stringify({ action: 'subscribe', symbol, timeframe }));
    });
    addWsListener(ws, 'message', (event) => {
      try {
        const payload: any = JSON.parse(messageText(event));
        if (payload.ok || payload.type === 'connected') return;
        if (!isTradingViewPayloadForRequest(payload, symbol, timeframe)) return;
        const snapshot = snapshotFromBar(symbol, timeframe, payload.bar || payload);
        if (snapshot.ok) {
          entry.status = 'ready';
          entry.lastSnapshot = snapshot;
          clearTimeout(timer);
          resolve(snapshot);
        }
      } catch (error: any) {
        entry.lastError = error?.message || String(error);
      }
    });
    addWsListener(ws, 'error', (event) => {
      clearTimeout(timer);
      reject(new Error(event?.message || 'tradingview_ws_error'));
    });
  });

  return entry.lastSnapshot;
}

export async function tradingViewSnapshot(args: TradingViewArgs = {}): Promise<TradingViewSnapshot> {
  if (!isRealEnabled(args)) return fallbackSnapshot(args, 'real_ws_disabled');
  const requireReal = isStrictRealMarketDataRequired(args) || args.requireTradingViewRealtime === true;
  try {
    const snapshot = await wsSnapshot(args) || fallbackSnapshot(args, 'tradingview_ws_snapshot_empty');
    if (requireReal && !isTradingViewRealtimeSnapshot(snapshot)) throw new Error('tradingview_realtime_required');
    return snapshot;
  } catch (wsError: any) {
    try {
      return await latestFromHttp(args);
    } catch (_) {
      return fallbackSnapshot(args, wsError?.message || wsError);
    }
  }
}

export async function subscribeTradingViewMarketData(args: TradingViewArgs = {}) {
  const snapshot = await tradingViewSnapshot(args);
  return { ok: snapshot.ok !== false, subscribed: snapshot.ok !== false, providerMode: snapshot.providerMode, subscription: snapshot };
}

export function unsubscribeTradingViewMarketData(args: TradingViewArgs = {}) {
  const symbol = normalizeSymbol(args.symbol || 'BINANCE:BTCUSDT');
  const timeframe = String(args.timeframe || '1h');
  const key = `${symbol}:${timeframe}`;
  const entry = subscriptions.get(key);
  try {
    entry?.ws?.send?.(JSON.stringify({ action: 'unsubscribe', symbol, timeframe }));
    entry?.ws?.close?.();
  } catch (_) {
    // best-effort cleanup only
  }
  const removed = subscriptions.delete(key);
  return { ok: true, unsubscribed: removed, market: 'tradingview', key, count: subscriptions.size };
}

export function closeTradingViewSubscriptions() {
  for (const entry of subscriptions.values()) {
    try {
      entry?.ws?.close?.();
    } catch (_) {
      // best-effort cleanup only
    }
  }
  subscriptions.clear();
}
