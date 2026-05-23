// @ts-nocheck
// Fundamental metric and Korean stock signal helpers backed by Open DART rows.

function finite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 4) {
  const n = finite(value, null);
  return n == null ? null : Number(n.toFixed(digits));
}

function text(value, fallback = '') {
  return String(value ?? fallback ?? '').trim();
}

function pct(numerator, denominator) {
  const a = finite(numerator, null);
  const b = finite(denominator, null);
  if (a == null || b == null || b === 0) return null;
  return round(a / b, 6);
}

function amount(row) {
  return finite(row?.currentAmount ?? row?.thstrm_amount ?? row?.thstrmAmount, null);
}

function accountText(row) {
  return `${row?.accountId || row?.account_id || ''} ${row?.accountName || row?.account_nm || ''}`.toLowerCase();
}

function accountId(row) {
  return text(row?.accountId || row?.account_id).toLowerCase();
}

function accountName(row) {
  return text(row?.accountName || row?.account_nm);
}

function findAmount(rows = [], patterns = []) {
  const normalized = Array.isArray(rows) ? rows : [];
  for (const pattern of patterns) {
    const found = normalized.find((row) => pattern.test(accountText(row)));
    const value = amount(found);
    if (value != null) return value;
  }
  return null;
}

function findExactAccountAmount(rows = [], { ids = [], names = [], fallback = [] } = {}) {
  const normalized = Array.isArray(rows) ? rows : [];
  const wantedIds = new Set(ids.map((id) => text(id).toLowerCase()).filter(Boolean));
  const wantedNames = new Set(names.map((name) => text(name)).filter(Boolean));
  const exact = normalized.find((row) => wantedIds.has(accountId(row)) || wantedNames.has(accountName(row)));
  const exactValue = amount(exact);
  if (exactValue != null) return exactValue;
  return findAmount(normalized, fallback);
}

export function deriveFinancialSummary(financialRows = []) {
  const rows = Array.isArray(financialRows) ? financialRows : [];
  return {
    revenue: findExactAccountAmount(rows, {
      ids: ['ifrs-full_revenue', 'ifrs-full_revenuefromcontractswithcustomers'],
      names: ['매출액', '수익(매출액)', '영업수익'],
      fallback: [/매출액/u, /수익\(매출액\)/u, /영업수익/u],
    }),
    operatingIncome: findExactAccountAmount(rows, {
      ids: ['dart_operatingincomeloss', 'ifrs-full_profitlossfromoperatingactivities'],
      names: ['영업이익'],
      fallback: [/operatingincome/u, /^영업이익$/u],
    }),
    netIncome: findExactAccountAmount(rows, {
      ids: ['ifrs-full_profitloss'],
      names: ['당기순이익'],
      fallback: [/당기순이익/u, /분기순이익/u, /반기순이익/u],
    }),
    totalAssets: findExactAccountAmount(rows, {
      ids: ['ifrs-full_assets'],
      names: ['자산총계'],
      fallback: [/ifrs-full_assets/u, /^자산총계$/u],
    }),
    totalLiabilities: findExactAccountAmount(rows, {
      ids: ['ifrs-full_liabilities'],
      names: ['부채총계'],
      fallback: [/ifrs-full_liabilities/u, /^부채총계$/u],
    }),
    totalEquity: findExactAccountAmount(rows, {
      ids: ['ifrs-full_equity'],
      names: ['자본총계'],
      fallback: [/ifrs-full_equity/u, /^자본총계$/u],
    }),
    currentAssets: findExactAccountAmount(rows, {
      ids: ['ifrs-full_currentassets'],
      names: ['유동자산'],
      fallback: [/currentassets/u, /^유동자산$/u],
    }),
    currentLiabilities: findExactAccountAmount(rows, {
      ids: ['ifrs-full_currentliabilities'],
      names: ['유동부채'],
      fallback: [/currentliabilities/u, /^유동부채$/u],
    }),
  };
}

export function calculateCorpFundamental(input = {}) {
  const financial = input.financial || deriveFinancialSummary(input.financialRows || []);
  const marketCap = finite(input.marketCap ?? input.market_cap, null);
  const shares = finite(input.listedShares ?? input.listed_shares ?? input.shares, null);
  const price = finite(input.price ?? input.closePrice, null);
  const effectiveMarketCap = marketCap ?? (shares != null && price != null ? shares * price : null);
  const eps = shares ? pct(financial.netIncome, shares) : null;
  const bps = shares ? pct(financial.totalEquity, shares) : null;
  const revenueGrowth = input.previousFinancial?.revenue
    ? pct((financial.revenue || 0) - input.previousFinancial.revenue, input.previousFinancial.revenue)
    : null;
  const operatingIncomeGrowth = input.previousFinancial?.operatingIncome
    ? pct((financial.operatingIncome || 0) - input.previousFinancial.operatingIncome, input.previousFinancial.operatingIncome)
    : null;

  return {
    stockCode: text(input.stockCode || input.stock_code || input.symbol),
    corpCode: text(input.corpCode || input.corp_code),
    companyName: text(input.companyName || input.company_name || input.name),
    bsnsYear: text(input.bsnsYear || input.bsns_year),
    reprtCode: text(input.reprtCode || input.reprt_code || '11011'),
    marketCap: effectiveMarketCap,
    listedShares: shares,
    price,
    revenue: financial.revenue,
    operatingIncome: financial.operatingIncome,
    netIncome: financial.netIncome,
    totalAssets: financial.totalAssets,
    totalLiabilities: financial.totalLiabilities,
    totalEquity: financial.totalEquity,
    currentAssets: financial.currentAssets,
    currentLiabilities: financial.currentLiabilities,
    per: effectiveMarketCap != null && financial.netIncome ? round(effectiveMarketCap / financial.netIncome, 4) : null,
    pbr: effectiveMarketCap != null && financial.totalEquity ? round(effectiveMarketCap / financial.totalEquity, 4) : null,
    roe: pct(financial.netIncome, financial.totalEquity),
    roa: pct(financial.netIncome, financial.totalAssets),
    eps,
    bps,
    debtRatio: pct(financial.totalLiabilities, financial.totalEquity),
    currentRatio: pct(financial.currentAssets, financial.currentLiabilities),
    operatingMargin: pct(financial.operatingIncome, financial.revenue),
    netMargin: pct(financial.netIncome, financial.revenue),
    revenueGrowth,
    operatingIncomeGrowth,
    source: input.source || 'opendart',
    updatedAt: input.updatedAt || new Date().toISOString(),
  };
}

function scoreValue(fundamental = {}) {
  const per = finite(fundamental.per, null);
  const pbr = finite(fundamental.pbr, null);
  const perScore = per != null && per > 0 ? Math.max(0, Math.min(1, 1 - per / 40)) : 0.5;
  const pbrScore = pbr != null && pbr > 0 ? Math.max(0, Math.min(1, 1 - pbr / 8)) : 0.5;
  return round((perScore + pbrScore) / 2, 4);
}

function scoreQuality(fundamental = {}) {
  const roe = finite(fundamental.roe, null);
  const roa = finite(fundamental.roa, null);
  const debt = finite(fundamental.debtRatio ?? fundamental.debt_ratio, null);
  const currentRatio = finite(fundamental.currentRatio ?? fundamental.current_ratio, null);
  const roeScore = roe != null ? Math.max(0, Math.min(1, 0.5 + roe * 2)) : 0.5;
  const roaScore = roa != null ? Math.max(0, Math.min(1, 0.5 + roa * 3)) : 0.5;
  const debtScore = debt != null ? Math.max(0, Math.min(1, 1 - debt / 3)) : 0.5;
  const currentScore = currentRatio != null ? Math.max(0, Math.min(1, currentRatio / 2)) : 0.5;
  return round((roeScore + roaScore + debtScore + currentScore) / 4, 4);
}

function scoreGrowth(fundamental = {}) {
  const revenueGrowth = finite(fundamental.revenueGrowth ?? fundamental.revenue_growth, null);
  const opGrowth = finite(fundamental.operatingIncomeGrowth ?? fundamental.operating_income_growth, null);
  const values = [revenueGrowth, opGrowth].filter((value) => value != null);
  if (!values.length) return 0.5;
  const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
  return round(Math.max(0, Math.min(1, 0.5 + avg)), 4);
}

export function scoreCorpFundamental(fundamental = {}) {
  const value = scoreValue(fundamental);
  const quality = scoreQuality(fundamental);
  const growth = scoreGrowth(fundamental);
  const composite = round(value * 0.35 + quality * 0.45 + growth * 0.2, 4);
  return {
    value,
    quality,
    growth,
    composite,
    flags: [
      fundamental.per != null && fundamental.per > 0 && fundamental.per < 10 ? 'low_per' : null,
      fundamental.roe != null && fundamental.roe >= 0.15 ? 'high_roe' : null,
      fundamental.debtRatio != null && fundamental.debtRatio < 1 ? 'low_debt' : null,
      fundamental.revenueGrowth != null && fundamental.revenueGrowth > 0 ? 'positive_revenue_growth' : null,
    ].filter(Boolean),
  };
}

export function rankCorpFundamentals(rows = []) {
  const scored = (Array.isArray(rows) ? rows : [])
    .map((row) => ({ ...row, factorScores: scoreCorpFundamental(row) }))
    .sort((a, b) => Number(b.factorScores.composite || 0) - Number(a.factorScores.composite || 0));
  const total = scored.length || 1;
  return scored.map((row, index) => ({
    ...row,
    rank: index + 1,
    decile: Math.min(10, Math.floor((index / total) * 10) + 1),
  }));
}

export function buildFundamentalQuantRecommendation(fundamental = {}) {
  const scores = scoreCorpFundamental(fundamental);
  const reasons = [];
  if (fundamental.per != null && fundamental.per > 0 && fundamental.per < 10) reasons.push('PER<10');
  if (fundamental.roe != null && fundamental.roe > 0.15) reasons.push('ROE>15%');
  if (fundamental.debtRatio != null && fundamental.debtRatio < 1) reasons.push('debt_ratio<100%');
  if (fundamental.revenueGrowth != null && fundamental.revenueGrowth > 0) reasons.push('revenue_growth_positive');

  let action = 'observe';
  if (scores.composite >= 0.72 && reasons.length >= 3) action = 'long_watchlist';
  if ((fundamental.per || 0) > 50 && (fundamental.revenueGrowth || 0) < 0) action = 'avoid_or_reduce';

  return {
    stockCode: fundamental.stockCode || fundamental.stock_code || null,
    companyName: fundamental.companyName || fundamental.company_name || null,
    action,
    confidence: round(scores.composite, 4),
    scores,
    reasons,
    shadowOnly: true,
    liveOrderAllowed: false,
  };
}

export function buildEarningsSurpriseRecommendation(current = {}, previous = {}) {
  const currentOp = finite(current.operatingIncome, null);
  const previousOp = finite(previous.operatingIncome, null);
  const currentRevenue = finite(current.revenue, null);
  const previousRevenue = finite(previous.revenue, null);
  const operatingSurprise = currentOp != null && previousOp ? round((currentOp - previousOp) / Math.abs(previousOp), 6) : null;
  const revenueSurprise = currentRevenue != null && previousRevenue ? round((currentRevenue - previousRevenue) / Math.abs(previousRevenue), 6) : null;
  const score = [operatingSurprise, revenueSurprise].filter((v) => v != null).reduce((sum, v) => sum + v, 0);
  return {
    stockCode: current.stockCode || current.stock_code || null,
    companyName: current.companyName || current.company_name || null,
    action: score > 0.1 ? 'positive_surprise_watchlist' : score < -0.1 ? 'negative_surprise_avoid' : 'observe',
    operatingSurprise,
    revenueSurprise,
    confidence: round(Math.max(0, Math.min(1, 0.5 + score)), 4),
    holdingWindowTradingDays: 5,
    shadowOnly: true,
    liveOrderAllowed: false,
  };
}

export default {
  deriveFinancialSummary,
  calculateCorpFundamental,
  scoreCorpFundamental,
  rankCorpFundamentals,
  buildFundamentalQuantRecommendation,
  buildEarningsSurpriseRecommendation,
};
