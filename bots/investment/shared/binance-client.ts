// @ts-nocheck
/**
 * shared/binance-client.ts — Binance Spot 공용 클라이언트
 *
 * 기본 동작:
 * 1) BINANCE_USE_MCP=true (default) 이면 MCP 브리지 우선
 * 2) 조회성 action은 MCP 실패 시 CCXT 직접 호출 fallback
 *    주문성 action(market_buy/sell)은 fail-closed 처리
 *
 * 재귀 방지:
 * - MCP 서버 내부 Node 브리지에서는 BINANCE_MCP_BRIDGE=1 + BINANCE_USE_MCP=false 설정
 */

import ccxt from 'ccxt';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { loadSecrets } from './secrets.ts';

const BINANCE_MCP_ENABLED_DEFAULT = String(process.env.BINANCE_USE_MCP ?? 'true').toLowerCase() !== 'false';
const BINANCE_MCP_BRIDGE_MODE = process.env.BINANCE_MCP_BRIDGE === '1';
const BINANCE_MCP_TIMEOUT_MS = Math.max(4_000, Number(process.env.BINANCE_MCP_TIMEOUT_MS || 20_000));
const BINANCE_MCP_MUTATING_ACTIONS = new Set([
  'market_buy',
  'market_sell',
]);
const BINANCE_ORDER_RECONCILE_WINDOW_MS = Math.max(
  60_000,
  Number(process.env.BINANCE_ORDER_RECONCILE_WINDOW_MS || (30 * 60_000)),
);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BINANCE_MCP_SERVER_PATH = process.env.BINANCE_MCP_SERVER_PATH || path.resolve(__dirname, '../scripts/binance-market-mcp-server.py');
const execFileAsync = promisify(execFile);

let _exchange = null;

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function normalizeSymbol(symbol = '') {
  const text = String(symbol || '').trim().toUpperCase();
  if (!text) return 'BTC/USDT';
  if (text.includes('/')) return text;
  if (text.endsWith('USDT')) {
    const base = text.slice(0, -4);
    return `${base}/USDT`;
  }
  return `${text}/USDT`;
}

function normalizeClientOrderId(value = '') {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.slice(0, 36);
}

function parseJsonFromMixedStdout(stdout = '') {
  const text = String(stdout || '').trim();
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // fallback below
    }
  }
  const lines = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // keep scanning
    }
  }
  return null;
}

function isExpectedBinanceLookupMiss(action, parsed = {}) {
  if (String(action || '').trim().toLowerCase() !== 'fetch_order') return false;
  const message = String(parsed?.message || parsed?.error || '');
  return message.startsWith('binance_order_lookup_not_found:')
    || message.startsWith('binance_order_lookup_ambiguous:');
}

function shouldUseBinanceMcp() {
  return BINANCE_MCP_ENABLED_DEFAULT && !BINANCE_MCP_BRIDGE_MODE;
}

function resolveProjectRoot() {
  return process.env.PROJECT_ROOT
    || process.env.REPO_ROOT
    || path.resolve(__dirname, '../../..');
}

export function getBinanceExchange() {
  if (_exchange) return _exchange;
  const secrets = loadSecrets();
  _exchange = new ccxt.binance({
    apiKey: secrets.binance_api_key || '',
    secret: secrets.binance_api_secret || '',
    enableRateLimit: true,
    options: {
      defaultType: 'spot',
      warnOnFetchOpenOrdersWithoutSymbol: false,
    },
  });
  return _exchange;
}

async function runBinanceMcpBridge(action, payload = {}) {
  if (!shouldUseBinanceMcp()) return null;
  const normalizedAction = String(action || '').trim().toLowerCase();
  const isMutatingAction = BINANCE_MCP_MUTATING_ACTIONS.has(normalizedAction);
  try {
    const { stdout } = await execFileAsync(
      'python3',
      [
        BINANCE_MCP_SERVER_PATH,
        '--bridge-action',
        String(action || ''),
        '--payload-json',
        JSON.stringify(payload || {}),
        '--json',
      ],
      {
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...process.env,
          PROJECT_ROOT: resolveProjectRoot(),
          REPO_ROOT: resolveProjectRoot(),
          USE_HUB_SECRETS: process.env.USE_HUB_SECRETS || 'true',
        },
        timeout: BINANCE_MCP_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const parsed = parseJsonFromMixedStdout(stdout);
    if (!parsed || parsed.status !== 'ok') {
      throw new Error(parsed?.message || `Binance MCP bridge failed: ${action}`);
    }
    return parsed;
  } catch (error) {
    const parsedError = parseJsonFromMixedStdout(error?.stdout || '');
    if (!isMutatingAction && parsedError && isExpectedBinanceLookupMiss(action, parsedError)) {
      return parsedError;
    }
    if (isMutatingAction) {
      const failClosed = /** @type {any} */ (new Error(`Binance MCP bridge failed (${action}): ${error?.message || error}`));
      failClosed.code = 'binance_mcp_mutating_bridge_failed';
      failClosed.meta = {
        action: normalizedAction || null,
        failClosed: true,
        symbol: String(payload?.symbol || '').trim().toUpperCase() || null,
        clientOrderId: payload?.clientOrderId || payload?.newClientOrderId || null,
        amountUsdt: Number(payload?.amountUsdt || 0) || null,
        amount: Number(payload?.amount || 0) || null,
      };
      throw failClosed;
    }
    console.warn(`  ⚠️ [BINANCE MCP] bridge 실패 (${action}) — direct fallback: ${error?.message || error}`);
    return null;
  }
}

export function normalizeBinanceOrderResult(orderLike = {}) {
  const filled = toFiniteNumber(orderLike?.filled, toFiniteNumber(orderLike?.executedQty, 0));
  const cumulativeQuote = toFiniteNumber(orderLike?.cummulativeQuoteQty, 0);
  const average = toFiniteNumber(orderLike?.average, 0)
    || (filled > 0 && cumulativeQuote > 0 ? cumulativeQuote / filled : 0)
    || toFiniteNumber(orderLike?.price, 0);
  const cost = toFiniteNumber(orderLike?.cost, 0)
    || cumulativeQuote
    || (filled > 0 && average > 0 ? filled * average : 0);

  return {
    ...orderLike,
    id: orderLike?.id?.toString?.()
      ?? orderLike?.orderId?.toString?.()
      ?? orderLike?.clientOrderId?.toString?.()
      ?? null,
    symbol: normalizeSymbol(orderLike?.symbol || ''),
    side: String(orderLike?.side || '').trim().toLowerCase() || null,
    status: String(orderLike?.status || '').trim().toLowerCase() || 'unknown',
    amount: toFiniteNumber(orderLike?.amount, toFiniteNumber(orderLike?.origQty, 0)),
    filled,
    price: toFiniteNumber(orderLike?.price, average),
    average,
    cost,
  };
}

function extractOrderClientId(orderLike = {}) {
  return orderLike?.clientOrderId?.toString?.()
    ?? orderLike?.origClientOrderId?.toString?.()
    ?? orderLike?.info?.clientOrderId?.toString?.()
    ?? orderLike?.info?.origClientOrderId?.toString?.()
    ?? null;
}

function resolveFetchOrderRef(orderRef, symbolFallback = '') {
  if (orderRef && typeof orderRef === 'object' && !Array.isArray(orderRef)) {
    return {
      symbol: normalizeSymbol(orderRef.symbol || symbolFallback || ''),
      orderId: String(orderRef.orderId || '').trim() || null,
      clientOrderId: normalizeClientOrderId(orderRef.clientOrderId || orderRef.origClientOrderId || ''),
      submittedAtMs: toFiniteNumber(orderRef.submittedAtMs, 0) || null,
      side: String(orderRef.side || '').trim().toLowerCase() || null,
      allowAllOrdersFallback: orderRef.allowAllOrdersFallback !== false,
    };
  }
  return {
    symbol: normalizeSymbol(symbolFallback || ''),
    orderId: String(orderRef || '').trim() || null,
    clientOrderId: null,
    submittedAtMs: null,
    side: null,
    allowAllOrdersFallback: true,
  };
}

function getAllOrdersTimeWindow(submittedAtMs = null) {
  const now = Date.now();
  if (!submittedAtMs || submittedAtMs <= 0) {
    const startTime = now - BINANCE_ORDER_RECONCILE_WINDOW_MS;
    return { startTime, endTime: now };
  }
  const startTime = Math.max(0, Math.round(submittedAtMs - BINANCE_ORDER_RECONCILE_WINDOW_MS));
  const endTime = Math.round(submittedAtMs + BINANCE_ORDER_RECONCILE_WINDOW_MS);
  return {
    startTime: Math.min(startTime, now),
    endTime: Math.max(endTime, now),
  };
}

function normalizeTickerSnapshot(symbol, ticker = {}) {
  const normalizedSymbol = normalizeSymbol(symbol || ticker?.symbol || '');
  return {
    symbol: normalizedSymbol,
    bid: toFiniteNumber(ticker?.bid, 0),
    ask: toFiniteNumber(ticker?.ask, 0),
    last: toFiniteNumber(ticker?.last, toFiniteNumber(ticker?.close, 0)),
    open: toFiniteNumber(ticker?.open, 0),
    high: toFiniteNumber(ticker?.high, 0),
    low: toFiniteNumber(ticker?.low, 0),
    volume: toFiniteNumber(ticker?.baseVolume, toFiniteNumber(ticker?.volume, 0)),
    quoteVolume: toFiniteNumber(ticker?.quoteVolume, 0),
    timestamp: toFiniteNumber(ticker?.timestamp, Date.now()),
    datetime: ticker?.datetime || new Date().toISOString(),
    raw: ticker,
  };
}

export async function getBinanceTickerSnapshot(symbol = 'BTC/USDT') {
  const normalizedSymbol = normalizeSymbol(symbol);
  const bridged = await runBinanceMcpBridge('quote', { symbol: normalizedSymbol });
  if (bridged?.quote) return bridged.quote;

  const ex = getBinanceExchange();
  const ticker = await ex.fetchTicker(normalizedSymbol);
  return normalizeTickerSnapshot(normalizedSymbol, ticker);
}

export async function getTickerLastPrice(symbol = 'BTC/USDT') {
  const quote = await getBinanceTickerSnapshot(symbol);
  return toFiniteNumber(quote?.last, 0);
}

function normalizeBalanceSnapshot(balance = {}, omitZeroBalances = true, includeRaw = false) {
  const sourceFree = balance?.free || {};
  const sourceUsed = balance?.used || {};
  const sourceTotal = balance?.total || {};
  const free = {};
  const used = {};
  const total = {};
  const assets = new Set([...Object.keys(sourceFree), ...Object.keys(sourceUsed), ...Object.keys(sourceTotal)]);

  for (const asset of assets) {
    const freeValue = toFiniteNumber(sourceFree[asset], 0);
    const usedValue = toFiniteNumber(sourceUsed[asset], 0);
    const totalValue = toFiniteNumber(sourceTotal[asset], freeValue + usedValue);
    if (omitZeroBalances && Math.abs(totalValue) <= 1e-12) continue;
    free[asset] = freeValue;
    used[asset] = usedValue;
    total[asset] = totalValue;
  }

  const snapshot = {
    free,
    used,
    total,
    timestamp: toFiniteNumber(balance?.timestamp, Date.now()),
    datetime: balance?.datetime || new Date().toISOString(),
  };
  if (includeRaw) snapshot.raw = balance;
  return snapshot;
}

export async function getBinanceBalanceSnapshot({ omitZeroBalances = true, includeRaw = false } = {}) {
  const bridged = await runBinanceMcpBridge('balance', { omitZeroBalances: Boolean(omitZeroBalances) });
  if (bridged?.balance) return bridged.balance;

  const ex = getBinanceExchange();
  const balance = await ex.fetchBalance();
  return normalizeBalanceSnapshot(balance, omitZeroBalances, includeRaw);
}

export async function getUsdtFreeBalance() {
  const balance = await getBinanceBalanceSnapshot({ omitZeroBalances: false });
  return toFiniteNumber(balance?.free?.USDT, 0);
}

export async function createBinanceMarketBuy(symbol, amountUsdt, options = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const quoteOrderQty = toFiniteNumber(amountUsdt, 0);
  const clientOrderId = normalizeClientOrderId(options?.clientOrderId || options?.newClientOrderId || '');
  if (quoteOrderQty <= 0) {
    throw new Error(`invalid_quote_order_qty:${amountUsdt}`);
  }
  const smokeCaptureEnabled = process.env.BINANCE_MCP_SMOKE_CAPTURE === '1' && process.env.NODE_ENV === 'test';
  if (smokeCaptureEnabled) {
    const smokeOrderId = `SMOKE-BUY-${Date.now()}`;
    return normalizeBinanceOrderResult({
      id: smokeOrderId,
      orderId: smokeOrderId,
      clientOrderId,
      symbol: normalizedSymbol,
      side: 'buy',
      status: 'closed',
      amount: quoteOrderQty,
      filled: quoteOrderQty,
      price: 1,
      average: 1,
      cost: quoteOrderQty,
    });
  }

  const bridged = await runBinanceMcpBridge('market_buy', {
    symbol: normalizedSymbol,
    amountUsdt: quoteOrderQty,
    clientOrderId,
  });
  if (bridged?.order) return normalizeBinanceOrderResult(bridged.order);

  const ex = getBinanceExchange();
  const params = { quoteOrderQty };
  if (clientOrderId) params.newClientOrderId = clientOrderId;
  const rawOrder = await ex.createOrder(
    normalizedSymbol,
    'market',
    'buy',
    undefined,
    undefined,
    params,
  );
  return normalizeBinanceOrderResult(rawOrder);
}

export async function createBinanceMarketSell(symbol, amount, options = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const quantity = toFiniteNumber(amount, 0);
  const clientOrderId = normalizeClientOrderId(options?.clientOrderId || options?.newClientOrderId || '');
  if (quantity <= 0) {
    throw new Error(`invalid_sell_quantity:${amount}`);
  }
  const smokeCaptureEnabled = process.env.BINANCE_MCP_SMOKE_CAPTURE === '1' && process.env.NODE_ENV === 'test';
  if (smokeCaptureEnabled) {
    const smokeOrderId = `SMOKE-SELL-${Date.now()}`;
    return normalizeBinanceOrderResult({
      id: smokeOrderId,
      orderId: smokeOrderId,
      clientOrderId,
      symbol: normalizedSymbol,
      side: 'sell',
      status: 'closed',
      amount: quantity,
      filled: quantity,
      price: 1,
      average: 1,
      cost: quantity,
    });
  }

  const bridged = await runBinanceMcpBridge('market_sell', {
    symbol: normalizedSymbol,
    amount: quantity,
    clientOrderId,
  });
  if (bridged?.order) return normalizeBinanceOrderResult(bridged.order);

  const ex = getBinanceExchange();
  const params = {};
  if (clientOrderId) params.newClientOrderId = clientOrderId;
  const rawOrder = await ex.createOrder(normalizedSymbol, 'market', 'sell', quantity, undefined, params);
  return normalizeBinanceOrderResult(rawOrder);
}

export async function fetchBinanceAllOrders(symbol, {
  startTime = null,
  endTime = null,
  limit = 200,
} = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const start = toFiniteNumber(startTime, 0) || null;
  const end = toFiniteNumber(endTime, 0) || null;
  const safeLimit = Math.max(1, Math.min(1000, Math.round(Number(limit || 200))));

  const bridged = await runBinanceMcpBridge('all_orders', {
    symbol: normalizedSymbol,
    startTime: start,
    endTime: end,
    limit: safeLimit,
  });
  if (Array.isArray(bridged?.orders)) {
    return bridged.orders.map((order) => normalizeBinanceOrderResult(order));
  }

  const ex = getBinanceExchange();
  const params = {};
  if (end) params.endTime = Math.round(end);
  const orders = await ex.fetchOrders(normalizedSymbol, start ? Math.round(start) : undefined, safeLimit, params);
  return (orders || []).map((order) => normalizeBinanceOrderResult(order));
}

export async function fetchBinanceOrder(orderRef, symbol = '') {
  const ref = resolveFetchOrderRef(orderRef, symbol);
  const { symbol: normalizedSymbol, orderId, clientOrderId } = ref;
  if (!normalizedSymbol) {
    throw new Error('fetchBinanceOrder requires symbol');
  }
  if (!orderId && !clientOrderId) {
    throw new Error('fetchBinanceOrder requires orderId or clientOrderId');
  }

  const bridged = await runBinanceMcpBridge('fetch_order', {
    symbol: normalizedSymbol,
    orderId,
    clientOrderId,
    submittedAtMs: ref.submittedAtMs,
    side: ref.side,
    allowAllOrdersFallback: ref.allowAllOrdersFallback !== false,
  });
  if (bridged?.order) return normalizeBinanceOrderResult(bridged.order);

  const ex = getBinanceExchange();
  const lookupErrors = [];

  if (orderId) {
    try {
      const byOrderId = await ex.fetchOrder(orderId, normalizedSymbol);
      if (byOrderId) return normalizeBinanceOrderResult(byOrderId);
    } catch (error) {
      lookupErrors.push(error);
    }
  }

  if (clientOrderId) {
    try {
      let byClientId = null;
      if (orderId) {
        byClientId = await ex.fetchOrder(orderId, normalizedSymbol, {
          origClientOrderId: clientOrderId,
        });
      } else if (typeof ex.privateGetOrder === 'function') {
        await ex.loadMarkets();
        const market = ex.market(normalizedSymbol);
        const marketId = market?.id || normalizedSymbol.replace('/', '');
        const rawByClientId = await ex.privateGetOrder({
          symbol: marketId,
          origClientOrderId: clientOrderId,
        });
        byClientId = typeof ex.parseOrder === 'function'
          ? ex.parseOrder(rawByClientId, market)
          : rawByClientId;
      }
      if (byClientId) return normalizeBinanceOrderResult(byClientId);
    } catch (error) {
      lookupErrors.push(error);
    }
  }

  if (clientOrderId && ref.allowAllOrdersFallback !== false) {
    const { startTime, endTime } = getAllOrdersTimeWindow(ref.submittedAtMs);
    try {
      const orders = await fetchBinanceAllOrders(normalizedSymbol, {
        startTime,
        endTime,
        limit: 1000,
      });
      const side = ref.side || null;
      const matches = (orders || []).filter((order) => {
        const normalizedClient = normalizeClientOrderId(extractOrderClientId(order) || '');
        if (!normalizedClient || normalizedClient !== clientOrderId) return false;
        if (side && String(order?.side || '').toLowerCase() !== side) return false;
        return true;
      });
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        const ambiguousError = /** @type {any} */ (new Error(
          `binance_order_lookup_ambiguous:${normalizedSymbol}:${clientOrderId}:${matches.length}`,
        ));
        ambiguousError.code = 'binance_order_lookup_ambiguous';
        ambiguousError.meta = {
          symbol: normalizedSymbol,
          clientOrderId,
          count: matches.length,
        };
        throw ambiguousError;
      }
      const notFoundError = /** @type {any} */ (new Error(
        `binance_order_lookup_not_found:${normalizedSymbol}:${clientOrderId}`,
      ));
      notFoundError.code = 'binance_order_lookup_not_found';
      notFoundError.meta = {
        symbol: normalizedSymbol,
        clientOrderId,
      };
      throw notFoundError;
    } catch (error) {
      lookupErrors.push(error);
    }
  }

  const lastError = lookupErrors[lookupErrors.length - 1];
  if (lastError) throw lastError;
  throw new Error(`binance_order_lookup_failed:${normalizedSymbol}:${orderId || clientOrderId || 'unknown'}`);
}

export async function getBinanceOpenOrders(symbol = '') {
  const normalizedSymbol = String(symbol || '').trim()
    ? normalizeSymbol(symbol)
    : '';
  const bridged = await runBinanceMcpBridge('open_orders', {
    symbol: normalizedSymbol,
  });
  if (Array.isArray(bridged?.orders)) {
    return bridged.orders.map((order) => normalizeBinanceOrderResult(order));
  }

  const ex = getBinanceExchange();
  const orders = normalizedSymbol
    ? await ex.fetchOpenOrders(normalizedSymbol)
    : await ex.fetchOpenOrders();
  return (orders || []).map((order) => normalizeBinanceOrderResult(order));
}

export async function testBinanceConnectivity(symbol = 'BTC/USDT') {
  const normalizedSymbol = normalizeSymbol(symbol);
  const quote = await getBinanceTickerSnapshot(normalizedSymbol);
  const balance = await getBinanceBalanceSnapshot({ omitZeroBalances: true });
  const nonZeroAssetCount = Object.keys(balance?.total || {}).length;
  return {
    status: 'ok',
    symbol: normalizedSymbol,
    quote,
    nonZeroAssetCount,
    checkedAt: new Date().toISOString(),
  };
}
