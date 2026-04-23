// @ts-nocheck
import https from 'https';

const SEC_USER_AGENT = process.env.SEC_USER_AGENT || 'ai-agent-system/1.0 contact:ops@local.invalid';
let _secTickerMapCache = null;
let _secTickerMapLoadedAt = 0;

function httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new Error(`JSON parse failed: ${String(raw || '').slice(0, 120)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

function httpsGetWithHeaders(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve(raw));
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.end();
  });
}

function extractRawValue(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    if (value.raw != null) return value.raw;
    if (value.fmt != null) return value.fmt;
  }
  return null;
}

function daysUntil(epochSeconds) {
  if (!Number.isFinite(Number(epochSeconds))) return null;
  return Math.round((Number(epochSeconds) * 1000 - Date.now()) / (24 * 3600 * 1000));
}

async function loadSecTickerMap() {
  if (_secTickerMapCache && Date.now() - _secTickerMapLoadedAt < 12 * 3600 * 1000) {
    return _secTickerMapCache;
  }
  const raw = await httpsGetWithHeaders(
    'www.sec.gov',
    '/files/company_tickers.json',
    {
      'User-Agent': SEC_USER_AGENT,
      'Accept': 'application/json',
    },
  );
  const data = JSON.parse(raw);
  const map = new Map();
  for (const row of Object.values(data || {})) {
    const ticker = String(row?.ticker || '').trim().toUpperCase();
    const cik = String(row?.cik_str || '').trim();
    if (!ticker || !cik) continue;
    map.set(ticker, cik.padStart(10, '0'));
  }
  _secTickerMapCache = map;
  _secTickerMapLoadedAt = Date.now();
  return map;
}

async function getSecFilingIntel(symbol) {
  try {
    const tickerMap = await loadSecTickerMap();
    const cik = tickerMap.get(String(symbol || '').trim().toUpperCase());
    if (!cik) return null;

    const raw = await httpsGetWithHeaders(
      'data.sec.gov',
      `/submissions/CIK${cik}.json`,
      {
        'User-Agent': SEC_USER_AGENT,
        'Accept': 'application/json',
      },
    );
    const data = JSON.parse(raw);
    const recent = data?.filings?.recent || {};
    const forms = Array.isArray(recent?.form) ? recent.form : [];
    const filingDates = Array.isArray(recent?.filingDate) ? recent.filingDate : [];
    const accessionNumbers = Array.isArray(recent?.accessionNumber) ? recent.accessionNumber : [];

    const rows = forms.slice(0, 12).map((form, idx) => ({
      form: String(form || '').trim(),
      filingDate: String(filingDates[idx] || '').trim() || null,
      accessionNumber: String(accessionNumbers[idx] || '').trim() || null,
    }));

    const cutoff = Date.now() - (30 * 24 * 3600 * 1000);
    const recent30 = rows.filter((row) => {
      const ts = row.filingDate ? Date.parse(row.filingDate) : NaN;
      return Number.isFinite(ts) && ts >= cutoff;
    });

    const formCounts = recent30.reduce((acc, row) => {
      if (!row.form) return acc;
      acc[row.form] = Number(acc[row.form] || 0) + 1;
      return acc;
    }, {});

    const materialForms = recent30
      .filter((row) => /^(8-K|10-K|10-Q|6-K|20-F)$/i.test(row.form))
      .slice(0, 5);

    return {
      cik,
      recentForms: rows.slice(0, 5),
      recent30Count: recent30.length,
      recent30FormCounts: formCounts,
      materialForms,
      latestMaterialForm: materialForms[0] || null,
    };
  } catch (error) {
    return {
      error: error.message,
    };
  }
}

export async function getYahooStockEventIntel(symbol) {
  try {
    const secIntel = await getSecFilingIntel(symbol).catch(() => null);
    const modules = [
      'calendarEvents',
      'financialData',
      'recommendationTrend',
      'upgradeDowngradeHistory',
      'summaryDetail',
    ].join(',');
    const data = await httpsGet(
      'query1.finance.yahoo.com',
      `/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`,
    );
    const result = data?.quoteSummary?.result?.[0];
    if (!result) {
      return {
        symbol,
        earningsDate: null,
        earningsDays: null,
        exDividendDate: null,
        exDividendDays: null,
        recommendationMean: null,
        analystCount: null,
        targetMeanPrice: null,
        recentUpgrades: 0,
        recentDowngrades: 0,
        trendNow: null,
        secFilings: secIntel && !secIntel.error ? secIntel : null,
        secFilingError: secIntel?.error || null,
      };
    }

    const earningsEpoch = extractRawValue(result?.calendarEvents?.earnings?.earningsDate?.[0]);
    const exDividendEpoch = extractRawValue(result?.calendarEvents?.exDividendDate);
    const recommendationMean = Number(extractRawValue(result?.financialData?.recommendationMean) || 0);
    const analystCount = Number(extractRawValue(result?.financialData?.numberOfAnalystOpinions) || 0);
    const targetMeanPrice = Number(extractRawValue(result?.financialData?.targetMeanPrice) || 0);
    const recommendationTrend = Array.isArray(result?.recommendationTrend?.trend) ? result.recommendationTrend.trend : [];
    const ratingNow = recommendationTrend[0] || null;
    const upgrades = Array.isArray(result?.upgradeDowngradeHistory?.history) ? result.upgradeDowngradeHistory.history : [];
    const recentCutoff = Date.now() - (30 * 24 * 3600 * 1000);
    const recentChanges = upgrades.filter((item) => Number(item?.epochGradeDate || 0) * 1000 >= recentCutoff);
    const recentUpgrades = recentChanges.filter((item) => {
      const action = String(item?.action || '').toLowerCase();
      return action.includes('up') || action.includes('main');
    }).length;
    const recentDowngrades = recentChanges.filter((item) => {
      const action = String(item?.action || '').toLowerCase();
      return action.includes('down');
    }).length;

    return {
      symbol,
      earningsDate: earningsEpoch ? new Date(Number(earningsEpoch) * 1000).toISOString() : null,
      earningsDays: daysUntil(earningsEpoch),
      exDividendDate: exDividendEpoch ? new Date(Number(exDividendEpoch) * 1000).toISOString() : null,
      exDividendDays: daysUntil(exDividendEpoch),
      recommendationMean: Number.isFinite(recommendationMean) && recommendationMean > 0 ? recommendationMean : null,
      analystCount: analystCount > 0 ? analystCount : null,
      targetMeanPrice: targetMeanPrice > 0 ? targetMeanPrice : null,
      recentUpgrades,
      recentDowngrades,
      trendNow: ratingNow ? {
        strongBuy: Number(ratingNow?.strongBuy || 0),
        buy: Number(ratingNow?.buy || 0),
        hold: Number(ratingNow?.hold || 0),
        sell: Number(ratingNow?.sell || 0),
        strongSell: Number(ratingNow?.strongSell || 0),
      } : null,
      secFilings: secIntel && !secIntel.error ? secIntel : null,
      secFilingError: secIntel?.error || null,
    };
  } catch (error) {
    return {
      symbol,
      error: error.message,
    };
  }
}
