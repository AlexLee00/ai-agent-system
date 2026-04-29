// @ts-nocheck
import { query, run } from './core.ts';

export async function insertScreeningHistory({ market, core = [], dynamic = [], screeningData = null }) {
  await run(`
    INSERT INTO screening_history (date, market, core_symbols, dynamic_symbols, screening_data)
    VALUES (CURRENT_DATE, $1, $2, $3, $4)
  `, [
    market,
    JSON.stringify(core),
    JSON.stringify(dynamic),
    screeningData ? JSON.stringify(screeningData) : null,
  ]);
}

export async function getRecentScreeningSymbols(market, limit = 3) {
  const rows = await query(`
    SELECT market, dynamic_symbols, core_symbols, screening_data, created_at
    FROM screening_history
    WHERE market = $1 OR market = 'all'
    ORDER BY created_at DESC
    LIMIT $2
  `, [market, limit]);

  const symbols = [];
  const isValidCryptoSymbol = (sym) => (
    typeof sym === 'string'
    && /^[A-Z0-9]+\/USDT$/.test(sym.trim().toUpperCase())
    && sym.trim().length > 6
  );
  for (const row of rows) {
    const screeningData = row.screening_data && typeof row.screening_data === 'object'
      ? row.screening_data
      : row.screening_data ? JSON.parse(row.screening_data) : null;

    const dynamic = row.market === 'all'
      ? (screeningData?.[market]?.dynamic || [])
      : Array.isArray(row.dynamic_symbols)
        ? row.dynamic_symbols
        : JSON.parse(row.dynamic_symbols || '[]');
    const core = row.market === 'all'
      ? (screeningData?.[market]?.core || [])
      : Array.isArray(row.core_symbols)
        ? row.core_symbols
        : row.core_symbols && typeof row.core_symbols === 'object'
          ? Object.values(row.core_symbols).flat()
          : JSON.parse(row.core_symbols || '[]');
    for (const sym of [...dynamic, ...core]) {
      if (market === 'crypto' && !isValidCryptoSymbol(sym)) continue;
      if (sym && !symbols.includes(sym)) symbols.push(sym);
    }
  }

  return symbols;
}

export async function getRecentScreeningDynamicSymbols(market, limit = 5) {
  const rows = await query(`
    SELECT market, dynamic_symbols, created_at
    FROM screening_history
    WHERE market = $1
    ORDER BY created_at DESC
    LIMIT $2
  `, [market, limit]);

  return rows.map((row) => ({
    market: row.market,
    created_at: row.created_at,
    dynamic_symbols: Array.isArray(row.dynamic_symbols)
      ? row.dynamic_symbols
      : JSON.parse(row.dynamic_symbols || '[]'),
  }));
}

export async function getRecentScreeningMarkets(limit = 6) {
  const rows = await query(`
    SELECT market, dynamic_symbols, created_at
    FROM screening_history
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);

  return rows.map((row) => ({
    market: String(row.market || '').trim() || 'unknown',
    created_at: row.created_at,
    dynamic_symbols: Array.isArray(row.dynamic_symbols)
      ? row.dynamic_symbols
      : JSON.parse(row.dynamic_symbols || '[]'),
  }));
}
