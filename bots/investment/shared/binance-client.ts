// @ts-nocheck
/**
 * shared/binance-client.ts — Binance Spot 공용 클라이언트
 *
 * 기본 동작:
 * 1) BINANCE_USE_MCP=true (default) 이면 MCP 브리지 우선
 * 2) MCP 실패 시 CCXT 직접 호출 fallback
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

export async function createBinanceMarketBuy(symbol, amountUsdt) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const quoteOrderQty = toFiniteNumber(amountUsdt, 0);
  if (quoteOrderQty <= 0) {
    throw new Error(`invalid_quote_order_qty:${amountUsdt}`);
  }

  const bridged = await runBinanceMcpBridge('market_buy', {
    symbol: normalizedSymbol,
    amountUsdt: quoteOrderQty,
  });
  if (bridged?.order) return normalizeBinanceOrderResult(bridged.order);

  const ex = getBinanceExchange();
  const rawOrder = await ex.createOrder(
    normalizedSymbol,
    'market',
    'buy',
    undefined,
    undefined,
    { quoteOrderQty },
  );
  return normalizeBinanceOrderResult(rawOrder);
}

export async function createBinanceMarketSell(symbol, amount) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const quantity = toFiniteNumber(amount, 0);
  if (quantity <= 0) {
    throw new Error(`invalid_sell_quantity:${amount}`);
  }

  const bridged = await runBinanceMcpBridge('market_sell', {
    symbol: normalizedSymbol,
    amount: quantity,
  });
  if (bridged?.order) return normalizeBinanceOrderResult(bridged.order);

  const ex = getBinanceExchange();
  const rawOrder = await ex.createOrder(normalizedSymbol, 'market', 'sell', quantity);
  return normalizeBinanceOrderResult(rawOrder);
}

export async function fetchBinanceOrder(orderId, symbol) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const idText = String(orderId || '').trim();
  if (!idText) {
    throw new Error('fetchBinanceOrder requires orderId');
  }

  const bridged = await runBinanceMcpBridge('fetch_order', {
    symbol: normalizedSymbol,
    orderId: idText,
  });
  if (bridged?.order) return normalizeBinanceOrderResult(bridged.order);

  const ex = getBinanceExchange();
  const rawOrder = await ex.fetchOrder(idText, normalizedSymbol);
  return normalizeBinanceOrderResult(rawOrder);
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
