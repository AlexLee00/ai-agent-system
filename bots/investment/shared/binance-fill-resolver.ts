// @ts-nocheck
/**
 * Binance fill resolver for journal reconciliation.
 *
 * Read-only by design. It uses fetchMyTrades to infer a real exit VWAP for
 * open trade_journal rows that are already absent from local positions.
 */

import ccxt from 'ccxt';
import { initHubSecrets, loadSecrets } from './secrets.ts';

const DEFAULT_LOOKBACK_MS = 60_000;
const DEFAULT_LIMIT = 1000;

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeSymbol(symbol = '') {
  const text = String(symbol || '').trim().toUpperCase();
  if (!text) return '';
  if (text.includes('/')) return text;
  if (text.endsWith('USDT')) return `${text.slice(0, -4)}/USDT`;
  return `${text}/USDT`;
}

function tolerance(value) {
  const n = Math.abs(num(value, 0));
  return Math.max(0.000001, n * 0.01);
}

async function getReadOnlyExchange() {
  await initHubSecrets().catch(() => false);
  const secrets = loadSecrets();
  if (!secrets.binance_api_key || !secrets.binance_api_secret) {
    throw new Error('binance_api_key_missing_after_hub_secret_init');
  }
  return new ccxt.binance({
    apiKey: secrets.binance_api_key,
    secret: secrets.binance_api_secret,
    enableRateLimit: true,
    options: {
      defaultType: 'spot',
      warnOnFetchOpenOrdersWithoutSymbol: false,
    },
  });
}

function normalizeTrade(raw = {}) {
  const amount = num(raw.amount ?? raw.info?.qty, 0);
  const price = num(raw.price, 0);
  const cost = num(raw.cost, amount * price);
  const side = raw.side
    ? String(raw.side).toLowerCase()
    : raw.info?.isBuyer === false
      ? 'sell'
      : raw.info?.isBuyer === true
        ? 'buy'
        : '';
  return {
    id: raw.id || raw.info?.id || null,
    order: raw.order || raw.orderId || raw.info?.orderId || null,
    timestamp: num(raw.timestamp, Date.parse(raw.datetime || '') || 0),
    datetime: raw.datetime || null,
    side,
    amount,
    price,
    cost,
    fee: raw.fee || null,
  };
}

export async function resolveFillForClosedJournal({
  symbol,
  entryTime,
  entrySize,
  entryPrice,
  entryValue,
  paperMode = false,
  expectedSide = 'sell',
  limit = DEFAULT_LIMIT,
} = {}) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const expectedQty = num(entrySize, 0);
  const expectedEntryValue = num(entryValue, expectedQty * num(entryPrice, 0));
  if (paperMode) {
    return { source: 'unresolved', reason: 'paper_mode_skip', symbol: normalizedSymbol, fillCount: 0 };
  }
  if (!normalizedSymbol || !(expectedQty > 0)) {
    return { source: 'unresolved', reason: 'invalid_symbol_or_qty', symbol: normalizedSymbol, fillCount: 0 };
  }

  const since = Math.max(0, num(entryTime, Date.now() - 30 * 24 * 3600_000) - DEFAULT_LOOKBACK_MS);
  try {
    const ex = await getReadOnlyExchange();
    const rawTrades = await ex.fetchMyTrades(normalizedSymbol, since, Math.max(1, num(limit, DEFAULT_LIMIT)));
    const side = String(expectedSide || 'sell').toLowerCase();
    const candidates = (rawTrades || [])
      .map(normalizeTrade)
      .filter((trade) => trade.side === side && trade.timestamp >= since && trade.amount > 0 && trade.price > 0)
      .sort((a, b) => a.timestamp - b.timestamp);

    const fills = [];
    let qty = 0;
    let value = 0;
    for (const trade of candidates) {
      fills.push(trade);
      qty += trade.amount;
      value += trade.cost || trade.amount * trade.price;
      if (qty + tolerance(expectedQty) >= expectedQty) break;
    }

    if (fills.length === 0) {
      return {
        source: 'unresolved',
        reason: 'no_matching_sell_fills',
        symbol: normalizedSymbol,
        since,
        fillCount: 0,
        inspectedTrades: candidates.length,
      };
    }

    const matched = qty + tolerance(expectedQty) >= expectedQty;
    if (!matched) {
      return {
        source: 'unresolved',
        reason: 'insufficient_sell_fill_quantity',
        symbol: normalizedSymbol,
        since,
        fillCount: fills.length,
        matchedQty: qty,
        expectedQty,
      };
    }

    const exitPrice = value > 0 && qty > 0 ? value / qty : null;
    const pnlAmount = exitPrice != null ? value - expectedEntryValue : null;
    const pnlPercent = expectedEntryValue > 0 && pnlAmount != null
      ? (pnlAmount / expectedEntryValue) * 100
      : null;

    return {
      source: 'fetchMyTrades',
      reason: 'matched_sell_fills',
      symbol: normalizedSymbol,
      since,
      fillCount: fills.length,
      matchedQty: qty,
      expectedQty,
      exitPrice,
      exitValue: value,
      pnlAmount,
      pnlPercent,
      pnlNet: pnlAmount,
      firstFillAt: fills[0]?.datetime || (fills[0]?.timestamp ? new Date(fills[0].timestamp).toISOString() : null),
      lastFillAt: fills[fills.length - 1]?.datetime || (fills[fills.length - 1]?.timestamp ? new Date(fills[fills.length - 1].timestamp).toISOString() : null),
      tradeIds: fills.map((fill) => fill.id).filter(Boolean),
      orderIds: [...new Set(fills.map((fill) => fill.order).filter(Boolean))],
    };
  } catch (error) {
    return {
      source: 'unresolved',
      reason: 'fetch_my_trades_failed',
      symbol: normalizedSymbol,
      fillCount: 0,
      error: String(error?.message || error || '').slice(0, 240),
    };
  }
}

export default {
  resolveFillForClosedJournal,
};
