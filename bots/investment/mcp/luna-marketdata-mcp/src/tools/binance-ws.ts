import { getMarketSnapshot, getOrderBook } from './market-snapshot.ts';
import { simulatedFallbackOrBlock } from './live-fallback-policy.ts';

const DEFAULT_WS_URL = 'wss://stream.binance.com:9443/ws';
const DEFAULT_DEPTH_URL = 'https://api.binance.com';
const DEFAULT_TIMEOUT_MS = Number(process.env.LUNA_MARKETDATA_REAL_TIMEOUT_MS || 5000);
const subscriptions = new Map();

function normalizeBinanceSymbol(symbol = 'BTC/USDT') {
  const text = String(symbol || 'BTC/USDT').trim().toUpperCase();
  if (text.includes('/')) return text;
  if (text.endsWith('USDT')) return `${text.slice(0, -4)}/USDT`;
  return text;
}

function streamSymbol(symbol = 'BTC/USDT') {
  return normalizeBinanceSymbol(symbol).replace('/', '').toLowerCase();
}

function hasNativeWebSocket() {
  return typeof globalThis.WebSocket === 'function';
}

function isRealEnabled(args = {}) {
  if (args.disableReal === true) return false;
  return process.env.LUNA_MARKETDATA_REAL_WS_ENABLED !== 'false';
}

function fallbackSnapshot(args = {}, reason = 'real_ws_unavailable') {
  return simulatedFallbackOrBlock(() => ({
    ...getMarketSnapshot({ ...args, market: 'binance' }),
    providerMode: 'simulated_fallback',
    fallbackReason: String(reason || 'real_ws_unavailable').slice(0, 240),
  }), { args, market: 'binance', symbol: args.symbol || 'BTC/USDT', reason, tool: 'get_market_snapshot' });
}

function fallbackOrderBook(args = {}, reason = 'real_order_book_unavailable') {
  return simulatedFallbackOrBlock(() => ({
    ...getOrderBook({ ...args, market: 'binance' }),
    providerMode: 'simulated_fallback',
    fallbackReason: String(reason || 'real_order_book_unavailable').slice(0, 240),
  }), { args, market: 'binance', symbol: args.symbol || 'BTC/USDT', reason, tool: 'get_order_book' });
}

function closeEntry(entry) {
  try {
    entry?.ws?.close?.();
  } catch (_) {
    // best-effort cleanup only
  }
}

function buildSnapshot(symbol, ticker = {}) {
  const price = Number(ticker.c || ticker.lastPrice || ticker.price || 0);
  const open = Number(ticker.o || 0);
  const high = Number(ticker.h || 0);
  const low = Number(ticker.l || 0);
  const volume24h = Number(ticker.v || ticker.volume || 0);
  const quoteVolume24h = Number(ticker.q || ticker.quoteVolume || 0);
  const changePct24h = Number(ticker.P || ticker.priceChangePercent || 0) / 100;
  return {
    ok: price > 0,
    source: 'binance_ws',
    providerMode: 'websocket',
    market: 'binance',
    symbol: normalizeBinanceSymbol(symbol),
    price,
    open,
    high,
    low,
    changePct24h,
    volume24h,
    quoteVolume24h,
    stale: false,
    exchangeEventAt: ticker.E ? new Date(Number(ticker.E)).toISOString() : null,
    fetchedAt: new Date().toISOString(),
  };
}

function addWsListener(ws, event, handler) {
  if (typeof ws.addEventListener === 'function') {
    ws.addEventListener(event, handler);
    return;
  }
  if (typeof ws.on === 'function') ws.on(event, handler);
}

function messageText(eventOrRaw) {
  const raw = eventOrRaw?.data ?? eventOrRaw;
  if (typeof raw === 'string') return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  return String(raw || '');
}

async function ensureSubscription(symbol, args = {}) {
  const normalizedSymbol = normalizeBinanceSymbol(symbol);
  const key = streamSymbol(normalizedSymbol);
  const existing = subscriptions.get(key);
  if (existing?.lastSnapshot?.ok) return existing;
  if (!hasNativeWebSocket()) throw new Error('native_websocket_unavailable');

  const timeoutMs = Math.max(250, Number(args.timeoutMs || DEFAULT_TIMEOUT_MS));
  const url = `${String(args.wsUrl || DEFAULT_WS_URL).replace(/\/$/, '')}/${key}@ticker`;
  const ws = new globalThis.WebSocket(url);
  const entry = {
    key,
    symbol: normalizedSymbol,
    url,
    ws,
    providerMode: 'websocket',
    status: 'connecting',
    openedAt: new Date().toISOString(),
    lastSnapshot: null,
    lastError: null,
  };
  subscriptions.set(key, entry);

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.status = entry.lastSnapshot?.ok ? 'ready' : 'timeout';
      if (entry.lastSnapshot?.ok) resolve(entry);
      else reject(new Error('binance_ws_snapshot_timeout'));
    }, timeoutMs);

    addWsListener(ws, 'open', () => {
      entry.status = 'open';
    });
    addWsListener(ws, 'message', (event) => {
      try {
        const ticker = JSON.parse(messageText(event));
        const snapshot = buildSnapshot(normalizedSymbol, ticker);
        if (snapshot.ok) {
          entry.status = 'ready';
          entry.lastSnapshot = snapshot;
          clearTimeout(timer);
          resolve(entry);
        }
      } catch (error) {
        entry.lastError = error?.message || String(error);
      }
    });
    addWsListener(ws, 'error', (event) => {
      entry.status = 'error';
      entry.lastError = event?.message || 'binance_ws_error';
      clearTimeout(timer);
      reject(new Error(entry.lastError));
    });
    addWsListener(ws, 'close', () => {
      if (entry.status !== 'ready') entry.status = 'closed';
    });
  });

  return entry;
}

export async function binanceSnapshot(args = {}) {
  if (!isRealEnabled(args)) return fallbackSnapshot(args, 'real_ws_disabled');
  try {
    const entry = await ensureSubscription(args.symbol || 'BTC/USDT', args);
    return entry.lastSnapshot || fallbackSnapshot(args, 'real_ws_no_snapshot');
  } catch (error) {
    return fallbackSnapshot(args, error?.message || error);
  }
}

export async function binanceOrderBook(args = {}) {
  if (!isRealEnabled(args)) return fallbackOrderBook(args, 'real_order_book_disabled');
  try {
    const symbol = streamSymbol(args.symbol || 'BTC/USDT').toUpperCase();
    const depth = Math.max(1, Math.min(100, Number(args.depth || 5)));
    const url = `${String(args.restBase || DEFAULT_DEPTH_URL).replace(/\/$/, '')}/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=${depth}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(Math.max(250, Number(args.timeoutMs || DEFAULT_TIMEOUT_MS))) });
    if (!response.ok) throw new Error(`binance_depth_http_${response.status}`);
    const body = await response.json();
    return {
      ok: true,
      source: 'binance_depth_rest',
      providerMode: 'rest',
      market: 'binance',
      symbol: normalizeBinanceSymbol(args.symbol || 'BTC/USDT'),
      bids: (body.bids || []).slice(0, depth).map(([price, size]) => [Number(price), Number(size)]),
      asks: (body.asks || []).slice(0, depth).map(([price, size]) => [Number(price), Number(size)]),
      lastUpdateId: body.lastUpdateId ?? null,
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    return fallbackOrderBook(args, error?.message || error);
  }
}

export async function subscribeBinanceMarketData(args = {}) {
  if (!isRealEnabled(args)) {
    const fallback = fallbackSnapshot(args, 'real_ws_disabled');
    return { ok: fallback.ok !== false, subscribed: fallback.ok !== false, providerMode: fallback.providerMode, subscription: fallback };
  }
  try {
    const entry = await ensureSubscription(args.symbol || 'BTC/USDT', args);
    return {
      ok: true,
      subscribed: true,
      providerMode: entry.providerMode,
      key: entry.key,
      status: entry.status,
      subscription: {
        market: 'binance',
        symbol: entry.symbol,
        openedAt: entry.openedAt,
        lastSnapshot: entry.lastSnapshot,
      },
    };
  } catch (error) {
    const fallback = fallbackSnapshot(args, error?.message || error);
    return { ok: fallback.ok !== false, subscribed: fallback.ok !== false, providerMode: fallback.providerMode, subscription: fallback };
  }
}

export function unsubscribeBinanceMarketData(args = {}) {
  const key = streamSymbol(args.symbol || 'BTC/USDT');
  const entry = subscriptions.get(key);
  closeEntry(entry);
  const removed = subscriptions.delete(key);
  return { ok: true, unsubscribed: removed, market: 'binance', key, count: subscriptions.size };
}

export function closeBinanceSubscriptions() {
  for (const entry of subscriptions.values()) closeEntry(entry);
  subscriptions.clear();
}
