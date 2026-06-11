// @ts-nocheck

import { getOHLCV } from './ohlcv-fetcher.ts';

export const DEFAULT_PHASE_A_SYMBOLS_BY_MARKET = Object.freeze({
  domestic: ['005930', '000660', '005380'],
  overseas: ['AAPL', 'NVDA', 'MSFT'],
  crypto: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
});

export const PHASE_A_MARKET_TO_EXCHANGE = Object.freeze({
  domestic: 'kis',
  overseas: 'kis_overseas',
  crypto: 'binance',
});

export function normalizePhaseAMarket(value = 'domestic') {
  const text = String(value || 'domestic').trim().toLowerCase();
  if (['crypto', 'binance'].includes(text)) return 'crypto';
  if (['overseas', 'us', 'usa', 'kis_overseas'].includes(text)) return 'overseas';
  return 'domestic';
}

export function exchangeForPhaseAMarket(market = 'domestic') {
  return PHASE_A_MARKET_TO_EXCHANGE[normalizePhaseAMarket(market)] || 'kis';
}

export function normalizePhaseASymbol(symbol = '', market = 'domestic') {
  const raw = String(symbol || '').trim();
  if (!raw) return raw;
  return normalizePhaseAMarket(market) === 'crypto' ? raw.toUpperCase().replace('-', '/') : raw.toUpperCase();
}

export function phaseADaysAgoIso(days = 120) {
  const date = new Date(Date.now() - Math.max(1, Number(days || 120)) * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

export function normalizePhaseABars(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      if (Array.isArray(row)) {
        return {
          timestamp: Number(row[0] || 0),
          open: Number(row[1]),
          high: Number(row[2]),
          low: Number(row[3]),
          close: Number(row[4]),
          volume: Number(row[5] || 0),
        };
      }
      return {
        timestamp: Number(row?.timestamp || row?.candle_ts || row?.time || 0),
        open: Number(row?.open ?? row?.o ?? row?.close),
        high: Number(row?.high ?? row?.h ?? row?.close),
        low: Number(row?.low ?? row?.l ?? row?.close),
        close: Number(row?.close ?? row?.c ?? row?.price),
        volume: Number(row?.volume ?? row?.v ?? 0),
      };
    })
    .filter((bar) => Number.isFinite(bar.close) && bar.close > 0)
    .sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
}

export async function fetchPhaseABars({
  symbol,
  market = 'domestic',
  timeframe = '1d',
  lookbackDays = 120,
  getOhlcv = getOHLCV,
} = {}) {
  const normalizedMarket = normalizePhaseAMarket(market);
  const normalizedSymbol = normalizePhaseASymbol(symbol, normalizedMarket);
  if (!normalizedSymbol) return { bars: [], source: 'missing_symbol', error: null };
  try {
    const rows = await Promise.resolve(getOhlcv(
      normalizedSymbol,
      String(timeframe || '1d'),
      phaseADaysAgoIso(lookbackDays),
      null,
      exchangeForPhaseAMarket(normalizedMarket),
    ));
    return {
      bars: normalizePhaseABars(rows),
      source: `${exchangeForPhaseAMarket(normalizedMarket)}_${String(timeframe || '1d')}_ohlcv`,
      error: null,
    };
  } catch (error) {
    return {
      bars: [],
      source: `${exchangeForPhaseAMarket(normalizedMarket)}_${String(timeframe || '1d')}_ohlcv_failed`,
      error: error?.message || String(error),
    };
  }
}

export default {
  DEFAULT_PHASE_A_SYMBOLS_BY_MARKET,
  PHASE_A_MARKET_TO_EXCHANGE,
  normalizePhaseAMarket,
  exchangeForPhaseAMarket,
  normalizePhaseASymbol,
  phaseADaysAgoIso,
  normalizePhaseABars,
  fetchPhaseABars,
};
