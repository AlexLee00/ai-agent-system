// @ts-nocheck

import ccxt from 'ccxt';
import * as db from './db.ts';
import { initHubSecrets, getMarketExecutionModeInfo, loadSecrets } from './secrets.ts';
import { getDomesticBalance, getOverseasBalance } from './kis-client.ts';
import { getInvestmentSyncRuntimeConfig } from './runtime-config.ts';

const MARKET_CONFIG = {
  domestic: { exchange: 'kis', marketType: 'stocks', label: '국내장' },
  overseas: { exchange: 'kis_overseas', marketType: 'stocks', label: '해외장' },
  crypto: { exchange: 'binance', marketType: 'crypto', label: '암호화폐' },
};
const SYNC_RUNTIME = getInvestmentSyncRuntimeConfig();
const CRYPTO_SYNC_MIN_NOTIONAL_USDT = Number(SYNC_RUNTIME.cryptoMinNotionalUsdt ?? 10);

let _binanceExchange = null;

function getBinanceExchange() {
  if (_binanceExchange) return _binanceExchange;
  const secrets = loadSecrets();
  _binanceExchange = new ccxt.binance({
    apiKey: secrets.binance_api_key || '',
    secret: secrets.binance_api_secret || '',
    options: { defaultType: 'spot' },
  });
  return _binanceExchange;
}

function roundQty(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

export function isStockSyncMarket(market) {
  return market === 'domestic' || market === 'overseas';
}

export function normalizeBrokerQuantityForMarket(market, qty = 0) {
  const value = Number(qty || 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (isStockSyncMarket(market)) return Math.floor(value);
  return value;
}

function positionQuantityEpsilonForMarket(market) {
  return isStockSyncMarket(market) ? 0.0001 : 0.000001;
}

export function estimatePositionNotionalUsdt(row = {}) {
  const amount = Math.abs(Number(row.amount ?? row.qty ?? 0));
  const avgPrice = Math.abs(Number(row.avg_price ?? row.avgPrice ?? 0));
  const explicitNotional = Math.abs(Number(row.notional ?? row.notionalUsdt ?? 0));
  if (explicitNotional > 0) return explicitNotional;
  if (amount > 0 && avgPrice > 0) return amount * avgPrice;
  return 0;
}

export function isMeaningfulTrackedPosition(row = {}, minNotionalUsdt = CRYPTO_SYNC_MIN_NOTIONAL_USDT) {
  return estimatePositionNotionalUsdt(row) >= Number(minNotionalUsdt || 0);
}

export function normalizeHolding(market, holding = {}) {
  const normalizedQty = normalizeBrokerQuantityForMarket(market, holding.qty || 0);
  if (market === 'domestic') {
    return {
      symbol: String(holding.symbol || '').trim(),
      qty: normalizedQty,
      avgPrice: Number(holding.avg_price || 0),
      unrealizedPnl: Number(holding.pnl_amt || 0),
      pnlPct: Number.isFinite(Number(holding.pnl_pct)) ? Number(holding.pnl_pct) : null,
      currentPrice: Number(holding.current_price || 0),
      raw: holding,
    };
  }

  return {
    symbol: String(holding.symbol || '').trim(),
    qty: normalizedQty,
    avgPrice: Number(holding.avg_price || 0),
    unrealizedPnl: Number(holding.pnl_usd || 0),
    pnlPct: Number.isFinite(Number(holding.pnl_pct)) ? Number(holding.pnl_pct) : null,
    notional: Number(holding.notional || 0),
    currentPrice: Number(holding.current_price || 0),
    raw: holding,
  };
}

export function allocateStockQuantities(totalQty, rows = []) {
  const total = Math.max(0, Math.floor(Number(totalQty || 0)));
  if (rows.length <= 1) return [total];

  const baseTotal = rows.reduce((sum, row) => sum + Math.max(0, Number(row.amount || 0)), 0);
  if (baseTotal <= 0) {
    return [total, ...rows.slice(1).map(() => 0)];
  }

  const provisional = rows.map((row) => {
    const share = Math.max(0, Number(row.amount || 0)) / baseTotal;
    const exact = total * share;
    return {
      qty: Math.floor(exact),
      remainder: exact - Math.floor(exact),
    };
  });

  let assigned = provisional.reduce((sum, item) => sum + item.qty, 0);
  let remaining = total - assigned;
  const order = provisional
    .map((item, index) => ({ index, remainder: item.remainder }))
    .sort((a, b) => b.remainder - a.remainder);

  let pointer = 0;
  while (remaining > 0 && order.length > 0) {
    provisional[order[pointer % order.length].index].qty += 1;
    remaining -= 1;
    pointer += 1;
  }

  return provisional.map((item) => item.qty);
}

function weightedExistingAvgPrice(rows = []) {
  const weighted = rows.reduce((acc, row) => {
    const amount = Math.max(0, Number(row.amount || 0));
    const avgPrice = Math.max(0, Number(row.avg_price || 0));
    if (!(amount > 0) || !(avgPrice > 0)) return acc;
    return {
      amount: acc.amount + amount,
      value: acc.value + (amount * avgPrice),
    };
  }, { amount: 0, value: 0 });

  if (weighted.amount <= 0) return 0;
  return weighted.value / weighted.amount;
}

function resolveSyncedAvgPrice(market, brokerHolding, existingRows = []) {
  const brokerAvgPrice = Number(brokerHolding?.avgPrice || 0);
  if (brokerAvgPrice > 0) return brokerAvgPrice;

  if (existingRows.length === 1) {
    const existingAvg = Number(existingRows[0]?.avg_price || 0);
    if (existingAvg > 0) return existingAvg;
  }

  const weightedExisting = weightedExistingAvgPrice(existingRows);
  if (weightedExisting > 0) return weightedExisting;

  if (market === 'crypto') {
    const inferredLastPrice = Number(brokerHolding?.notional || 0) > 0 && Number(brokerHolding?.qty || 0) > 0
      ? Number(brokerHolding.notional) / Number(brokerHolding.qty)
      : 0;
    if (inferredLastPrice > 0) return inferredLastPrice;
  }

  return 0;
}

export function buildRowsForBrokerHolding(market, brokerHolding, existingRows = []) {
  const syncedAvgPrice = resolveSyncedAvgPrice(market, brokerHolding, existingRows);

  if (!existingRows.length) {
    return [{
      symbol: brokerHolding.symbol,
      amount: normalizeBrokerQuantityForMarket(market, brokerHolding.qty),
      avgPrice: syncedAvgPrice,
      unrealizedPnl: brokerHolding.unrealizedPnl,
      tradeMode: 'normal',
    }];
  }

  if (existingRows.length === 1) {
    return [{
      symbol: brokerHolding.symbol,
      amount: normalizeBrokerQuantityForMarket(market, brokerHolding.qty),
      avgPrice: syncedAvgPrice,
      unrealizedPnl: brokerHolding.unrealizedPnl,
      tradeMode: existingRows[0].trade_mode || 'normal',
    }];
  }

  if (isStockSyncMarket(market)) {
    const brokerQty = normalizeBrokerQuantityForMarket(market, brokerHolding.qty);
    const allocations = allocateStockQuantities(brokerQty, existingRows);
    return existingRows
      .map((row, index) => ({
        symbol: brokerHolding.symbol,
        amount: allocations[index],
        avgPrice: Number(row.avg_price || 0) > 0 ? Number(row.avg_price || 0) : syncedAvgPrice,
        unrealizedPnl: brokerQty > 0
          ? brokerHolding.unrealizedPnl * (allocations[index] / brokerQty)
          : 0,
        tradeMode: row.trade_mode || 'normal',
      }))
      .filter((row) => Number(row.amount || 0) > 0);
  }

  const totalExisting = existingRows.reduce((sum, row) => sum + Math.max(0, Number(row.amount || 0)), 0);
  if (totalExisting <= 0) {
    return [{
      symbol: brokerHolding.symbol,
      amount: normalizeBrokerQuantityForMarket(market, brokerHolding.qty),
      avgPrice: brokerHolding.avgPrice,
      unrealizedPnl: brokerHolding.unrealizedPnl,
      tradeMode: existingRows[0]?.trade_mode || 'normal',
    }];
  }

  return existingRows
    .map((row) => {
      const weight = Math.max(0, Number(row.amount || 0)) / totalExisting;
      const amount = roundQty(brokerHolding.qty * weight, 8);
      return {
        symbol: brokerHolding.symbol,
        amount,
        avgPrice: Number(row.avg_price || 0) > 0 ? Number(row.avg_price || 0) : syncedAvgPrice,
        unrealizedPnl: brokerHolding.unrealizedPnl * weight,
        tradeMode: row.trade_mode || 'normal',
      };
    })
    .filter((row) => Number(row.amount || 0) > 0);
}

function summarizeMismatch(symbol, type, payload = {}) {
  return {
    symbol,
    type,
    ...payload,
  };
}

async function fetchOpenJournalAverage(exchange, symbol, tradeMode = 'normal', isPaper = false) {
  const row = await db.get(
    `SELECT
        SUM(entry_size) AS open_size,
        SUM(entry_value) AS open_value
       FROM trade_journal
      WHERE exchange = $1
        AND symbol = $2
        AND status = 'open'
        AND COALESCE(trade_mode, 'normal') = $3
        AND is_paper = $4`,
    [exchange, symbol, tradeMode || 'normal', Boolean(isPaper)],
  ).catch(() => null);

  const openSize = Number(row?.open_size || 0);
  const openValue = Number(row?.open_value || 0);
  if (!(openSize > 0) || !(openValue > 0)) return 0;
  return openValue / openSize;
}

export async function syncPositionsAtMarketOpen(market) {
  const config = MARKET_CONFIG[market];
  if (!config) {
    return {
      market,
      ok: false,
      skipped: true,
      reason: 'unsupported_market',
      positions: [],
      mismatches: [],
    };
  }

  await initHubSecrets();

  const modeInfo = getMarketExecutionModeInfo(config.marketType, config.label);
  const paperFlag = modeInfo.paper === true;
  const useMockAccount = modeInfo.brokerAccountMode === 'mock';
  if (market === 'crypto' && paperFlag) {
    const paperRows = await db.getAllPositions(config.exchange, true).catch(() => []);
    return {
      market,
      ok: true,
      skipped: true,
      reason: 'paper_mode_virtual_positions',
      exchange: config.exchange,
      executionMode: modeInfo.executionMode,
      brokerAccountMode: modeInfo.brokerAccountMode,
      paper: paperFlag,
      positions: paperRows.map((row) => ({
        symbol: row.symbol,
        amount: Number(row.amount || 0),
        pnl_pct: null,
        trade_modes: [String(row.trade_mode || 'normal')],
      })),
      brokerPositionCount: 0,
      dbPositionCountBefore: paperRows.length,
      mismatchCount: 0,
      mismatches: [],
    };
  }

  const dbRows = await db.getAllPositions(config.exchange, paperFlag).catch(() => []);
  const meaningfulTrackedSymbols = new Set(
    dbRows
      .filter((row) => isMeaningfulTrackedPosition(row, CRYPTO_SYNC_MIN_NOTIONAL_USDT))
      .map((row) => String(row.symbol || '').trim())
      .filter(Boolean),
  );

  const balance = market === 'domestic'
    ? await getDomesticBalance(useMockAccount)
    : market === 'overseas'
      ? await getOverseasBalance(useMockAccount)
      : await getBinanceExchange().fetchBalance();
  const cryptoTickers = market === 'crypto'
    ? await getBinanceExchange().fetchTickers().catch(() => ({}))
    : {};

  const brokerPositions = market === 'crypto'
    ? (() => {
      const rawHoldings = Object.entries(balance?.total || {})
        .map(([asset, qty]) => ({
          symbol: `${String(asset || '').trim().toUpperCase()}/USDT`,
          qty: Number(qty || 0),
        }))
        .filter((holding) => holding.symbol !== 'USDT/USDT' && Number(holding.qty || 0) > 0.0000001);

      const symbols = rawHoldings.map((holding) => holding.symbol);
      const tickers = symbols.length > 0 ? cryptoTickers : {};

      return rawHoldings
        .map((holding) => {
          const last = Number(tickers?.[holding.symbol]?.last || 0);
          const notional = last > 0 ? holding.qty * last : 0;
          return normalizeHolding(market, {
            symbol: holding.symbol,
            qty: holding.qty,
            avg_price: 0,
            pnl_usd: 0,
            pnl_pct: null,
            notional,
            current_price: last,
          });
        })
        .filter((holding) =>
          meaningfulTrackedSymbols.has(holding.symbol)
          || Number(holding.notional || 0) >= CRYPTO_SYNC_MIN_NOTIONAL_USDT,
        );
    })()
    : (balance?.holdings || [])
      .map((holding) => normalizeHolding(market, holding))
      .filter((holding) => holding.symbol && Number(holding.qty || 0) > 0);
  const dbBySymbol = new Map();
  for (const row of dbRows) {
    const symbol = String(row.symbol || '').trim();
    if (!symbol) continue;
    if (!dbBySymbol.has(symbol)) dbBySymbol.set(symbol, []);
    dbBySymbol.get(symbol).push(row);
  }

  const brokerBySymbol = new Map(brokerPositions.map((holding) => [holding.symbol, holding]));
  const allSymbols = [...new Set([...dbBySymbol.keys(), ...brokerBySymbol.keys()])];
  const mismatches = [];

  for (const symbol of allSymbols) {
    const brokerHolding = brokerBySymbol.get(symbol) || null;
    const dbRowsForSymbol = dbBySymbol.get(symbol) || [];
    const dbTotalQty = dbRowsForSymbol.reduce((sum, row) => sum + Number(row.amount || 0), 0);

    if (!brokerHolding && dbRowsForSymbol.length > 0) {
      mismatches.push(summarizeMismatch(symbol, 'stale_db_position', {
        dbQty: dbTotalQty,
        rowCount: dbRowsForSymbol.length,
      }));
      await db.deletePositionsForExchangeScope(config.exchange, { paper: paperFlag, symbol });
      continue;
    }

    if (brokerHolding && dbRowsForSymbol.length === 0) {
      mismatches.push(summarizeMismatch(symbol, 'missing_db_position', {
        brokerQty: brokerHolding.qty,
      }));
    } else if (brokerHolding && Math.abs(dbTotalQty - brokerHolding.qty) > positionQuantityEpsilonForMarket(market)) {
      mismatches.push(summarizeMismatch(symbol, 'quantity_mismatch', {
        dbQty: roundQty(dbTotalQty, 8),
        brokerQty: roundQty(brokerHolding.qty, 8),
      }));
    }

    if (brokerHolding && dbRowsForSymbol.length > 1) {
      mismatches.push(summarizeMismatch(symbol, 'trade_mode_split', {
        rowCount: dbRowsForSymbol.length,
        tradeModes: [...new Set(dbRowsForSymbol.map((row) => row.trade_mode || 'normal'))],
      }));
    }

    if (!brokerHolding) continue;

    await db.deletePositionsForExchangeScope(config.exchange, { paper: paperFlag, symbol });
    const scopedRows = buildRowsForBrokerHolding(market, brokerHolding, dbRowsForSymbol);
    for (const row of scopedRows) {
      let avgPrice = Number(row.avgPrice || 0);
      if (market === 'crypto' && !(avgPrice > 0)) {
        avgPrice = await fetchOpenJournalAverage(
          config.exchange,
          row.symbol,
          row.tradeMode || 'normal',
          paperFlag,
        );
      }
      let unrealizedPnl = Number(row.unrealizedPnl || 0);
      if (market === 'crypto') {
        const currentPrice = Number(
          brokerHolding.currentPrice
          || cryptoTickers?.[row.symbol]?.last
          || (Number(brokerHolding.notional || 0) > 0 && Number(brokerHolding.qty || 0) > 0
            ? Number(brokerHolding.notional) / Number(brokerHolding.qty)
            : 0),
        );
        if (currentPrice > 0 && avgPrice > 0) {
          unrealizedPnl = (currentPrice - avgPrice) * Number(row.amount || 0);
        }
      }
      await db.upsertPosition({
        symbol: row.symbol,
        amount: row.amount,
        avgPrice,
        unrealizedPnl,
        exchange: config.exchange,
        paper: paperFlag,
        tradeMode: row.tradeMode,
      });
    }
  }

  return {
    market,
    ok: true,
    exchange: config.exchange,
    executionMode: modeInfo.executionMode,
    brokerAccountMode: modeInfo.brokerAccountMode,
    paper: paperFlag,
    positions: brokerPositions.map((holding) => ({
      symbol: holding.symbol,
      amount: holding.qty,
      pnl_pct: holding.pnlPct,
      trade_modes: [],
    })),
    brokerPositionCount: brokerPositions.length,
    dbPositionCountBefore: dbRows.length,
    mismatchCount: mismatches.length,
    mismatches,
  };
}
