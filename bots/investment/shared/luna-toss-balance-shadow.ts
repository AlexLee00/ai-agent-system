// @ts-nocheck

import * as db from './db.ts';
import { getBrokerAdapter } from './brokers/broker-router.ts';

function normalizeMarket(value = 'domestic') {
  const raw = String(value || '').trim().toLowerCase();
  if (['overseas', 'us', 'usa', 'kis_overseas'].includes(raw)) return 'overseas';
  return 'domestic';
}

function normalizeSymbol(value = '') {
  return String(value || '').trim().toUpperCase();
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function positionSymbol(row = {}) {
  return normalizeSymbol(row.symbol || row.ticker || row.asset || row.coin || '');
}

function positionQuantity(row = {}) {
  return toNumber(row.amount ?? row.quantity ?? row.qty ?? row.size, 0);
}

function holdingQuantity(row = {}) {
  return toNumber(row.quantity ?? row.qty ?? row.amount, 0);
}

export async function loadOpenStockPositions({ market = 'domestic', queryFn = db.query } = {}) {
  const exchange = normalizeMarket(market) === 'domestic' ? 'kis' : 'kis_overseas';
  const rows = await queryFn(
    `SELECT symbol, amount, avg_price, exchange, updated_at
       FROM positions
      WHERE exchange = $1
        AND COALESCE(amount, 0) > 0
      ORDER BY updated_at DESC
      LIMIT 200`,
    [exchange],
  ).catch(() => []);
  return Array.isArray(rows) ? rows : [];
}

export function compareTossHoldingsWithPositions({ market = 'domestic', holdings = [], positions = [] } = {}) {
  const holdingRows = Array.isArray(holdings?.holdings) ? holdings.holdings : Array.isArray(holdings) ? holdings : [];
  const holdingBySymbol = new Map(holdingRows.map((row) => [normalizeSymbol(row.symbol), row]).filter(([symbol]) => symbol));
  const positionBySymbol = new Map((Array.isArray(positions) ? positions : []).map((row) => [positionSymbol(row), row]).filter(([symbol]) => symbol));
  const symbols = [...new Set([...holdingBySymbol.keys(), ...positionBySymbol.keys()])].sort();
  const deltas = symbols.map((symbol) => {
    const holding = holdingBySymbol.get(symbol) || null;
    const position = positionBySymbol.get(symbol) || null;
    const hQty = holding ? holdingQuantity(holding) : 0;
    const pQty = position ? positionQuantity(position) : 0;
    const quantityDelta = hQty - pQty;
    const status = !holding
      ? 'missing_in_toss'
      : !position
        ? 'extra_in_toss'
        : Math.abs(quantityDelta) > 1e-9
          ? 'quantity_delta'
          : 'matched';
    return {
      symbol,
      status,
      market: normalizeMarket(market),
      tossQuantity: hQty,
      positionQuantity: pQty,
      quantityDelta,
      tossMarketValue: toNumber(holding?.marketValue, null),
      positionAvgPrice: toNumber(position?.avg_price, null),
    };
  });
  return {
    ok: true,
    market: normalizeMarket(market),
    checked: deltas.length,
    mismatchCount: deltas.filter((row) => row.status !== 'matched').length,
    deltas,
    shadowOnly: true,
    liveMutation: false,
  };
}

export async function buildTossBalanceShadowComparison(options = {}, deps = {}) {
  const market = normalizeMarket(options.market || 'domestic');
  const adapter = deps.adapter || getBrokerAdapter('toss');
  const holdings = deps.holdings || await adapter.getHoldings?.(market, options).catch((error) => ({
    provider: 'toss',
    market,
    skipped: true,
    skippedReason: error?.message || String(error),
    holdings: [],
  }));
  if (holdings?.skipped === true) {
    return {
      ok: true,
      market,
      checked: 0,
      mismatchCount: 0,
      deltas: [],
      shadowOnly: true,
      liveMutation: false,
      holdingsSkipped: true,
      holdingsSkippedReason: holdings?.skippedReason || 'toss_holdings_unavailable',
    };
  }
  const positions = deps.positions || await (deps.loadPositions || loadOpenStockPositions)({
    market,
    queryFn: deps.queryFn || options.queryFn || db.query,
  });
  return {
    ...compareTossHoldingsWithPositions({ market, holdings, positions }),
    holdingsSkipped: holdings?.skipped === true,
    holdingsSkippedReason: holdings?.skippedReason || null,
  };
}

export default {
  loadOpenStockPositions,
  compareTossHoldingsWithPositions,
  buildTossBalanceShadowComparison,
};
