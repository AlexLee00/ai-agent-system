// @ts-nocheck
// Korean equity cross-sectional factor model for shadow evidence.

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 4) {
  const n = finite(value, null);
  return n == null ? null : Number(n.toFixed(digits));
}

function percentileRank(sortedAsc, value) {
  if (!sortedAsc.length || value == null) return 0.5;
  let below = 0;
  for (const item of sortedAsc) if (item <= value) below += 1;
  return below / sortedAsc.length;
}

function values(rows, field) {
  return rows.map((row) => finite(row[field], null)).filter((value) => value != null).sort((a, b) => a - b);
}

function normalizeRow(row = {}) {
  return {
    stockCode: row.stockCode || row.stock_code || row.symbol || null,
    companyName: row.companyName || row.company_name || row.name || null,
    marketCap: finite(row.marketCap ?? row.market_cap, null),
    per: finite(row.per, null),
    pbr: finite(row.pbr, null),
    roe: finite(row.roe, null),
    roa: finite(row.roa, null),
    debtRatio: finite(row.debtRatio ?? row.debt_ratio, null),
    revenueGrowth: finite(row.revenueGrowth ?? row.revenue_growth, null),
    momentum: finite(row.momentum ?? row.return_60d ?? row.return60d, null),
    raw: row,
  };
}

export function buildKoreanFactorSnapshot(inputRows = [], options = {}) {
  const rows = (Array.isArray(inputRows) ? inputRows : []).map(normalizeRow).filter((row) => row.stockCode);
  const caps = values(rows, 'marketCap');
  const pbrs = values(rows, 'pbr');
  const roes = values(rows, 'roe');
  const momentums = values(rows, 'momentum');
  const growths = values(rows, 'revenueGrowth');

  const scored = rows.map((row) => {
    const sizePct = percentileRank(caps, row.marketCap);
    const valuePct = row.pbr != null ? 1 - percentileRank(pbrs, row.pbr) : 0.5;
    const qualityPct = percentileRank(roes, row.roe);
    const momentumPct = percentileRank(momentums, row.momentum);
    const growthPct = percentileRank(growths, row.revenueGrowth);
    const composite = round(
      (1 - sizePct) * 0.15
      + valuePct * 0.3
      + qualityPct * 0.3
      + momentumPct * 0.15
      + growthPct * 0.1,
      4,
    );
    return {
      ...row,
      factors: {
        smb: round(1 - sizePct, 4),
        hml: round(valuePct, 4),
        quality: round(qualityPct, 4),
        wmr: round(momentumPct, 4),
        growth: round(growthPct, 4),
      },
      composite,
    };
  }).sort((a, b) => Number(b.composite || 0) - Number(a.composite || 0));

  const total = scored.length || 1;
  const ranked = scored.map((row, index) => ({
    ...row,
    rank: index + 1,
    decile: Math.min(10, Math.floor((index / total) * 10) + 1),
    allocationHint: row.composite >= 0.72 ? 'overweight_watchlist' : row.composite <= 0.35 ? 'underweight_or_avoid' : 'neutral',
  }));

  return {
    ok: ranked.length > 0,
    status: ranked.length ? 'korean_factor_model_ready' : 'korean_factor_model_empty',
    market: 'domestic',
    shadowOnly: true,
    factorNames: ['SMB', 'HML', 'WMR', 'QUALITY', 'GROWTH'],
    rows: ranked,
    top: ranked.slice(0, Number(options.top || 10)),
    bottom: ranked.slice(-Number(options.bottom || 10)).reverse(),
    generatedAt: new Date().toISOString(),
  };
}

export default { buildKoreanFactorSnapshot };
