// @ts-nocheck
import https from 'https';

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

export async function getYahooStockEventIntel(symbol) {
  try {
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
    if (!result) return null;

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
    };
  } catch (error) {
    return {
      symbol,
      error: error.message,
    };
  }
}
