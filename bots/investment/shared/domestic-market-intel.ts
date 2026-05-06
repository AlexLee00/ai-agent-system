// @ts-nocheck
/**
 * shared/domestic-market-intel.ts
 *
 * 국내장 공개 웹 기반 장중 모멘텀/랭크 인텔.
 * Argos 스크리닝에서 쓰는 네이버 상승 소스를 maintenance collect에서도
 * 재사용할 수 있도록 공통 helper로 분리한다.
 */

function normalizeSymbol(value) {
  return String(value || '').trim();
}

function toNumber(value, fallback = null) {
  const normalized = typeof value === 'string' ? value.replace(/[,\s]/g, '') : value;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : fallback;
}

function isNaverDomesticStock(row) {
  const endType = String(row?.stockEndType || '').toLowerCase();
  return !endType || endType === 'stock';
}

function normalizeNaverStock(row, index, source) {
  return {
    symbol: normalizeSymbol(row.stockCode || row.itemCode || row.reutersCode || row.cd || row.itemcode || row.code),
    name: String(row.stockName || row.nm || row.itemname || row.name || '').trim(),
    rank: index + 1,
    price: toNumber(row.closePrice || row.nv || row.now || row.close),
    changeRate: toNumber(row.fluctuationsRatio || row.cr || row.changeRate),
    volume: toNumber(row.accumulatedTradingVolume || row.aq || row.quant || row.volume),
    source,
  };
}

async function fetchJSON(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LunaDomesticIntel/1.0)',
        'Referer': 'https://finance.naver.com/',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LunaDomesticIntel/1.0)',
        'Referer': 'https://finance.naver.com/',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function tryNaverMobileUp() {
  try {
    const data = await fetchJSON('https://m.stock.naver.com/api/stocks/up/KOSPI?page=1&pageSize=30');
    const stocks = data?.stocks
      || data?.result?.stocks
      || data?.data?.stocks
      || data?.result?.data
      || [];
    if (!Array.isArray(stocks) || !stocks.length) return [];
    return stocks
      .filter(isNaverDomesticStock)
      .map((stock, index) => normalizeNaverStock(stock, index, 'naver_mobile_up'))
      .filter((item) => item.symbol);
  } catch {
    return [];
  }
}

async function tryNaverSiseUp() {
  try {
    const pages = await Promise.all([
      fetchJSON('https://m.stock.naver.com/api/stocks/up/KOSPI?page=1&pageSize=30'),
      fetchJSON('https://m.stock.naver.com/api/stocks/up/KOSDAQ?page=1&pageSize=30'),
    ]);
    const items = pages.flatMap((data) => data?.stocks || data?.result?.stocks || data?.itemList || data?.result || []);
    if (!Array.isArray(items) || !items.length) return [];
    return items
      .filter(isNaverDomesticStock)
      .map((item, index) => normalizeNaverStock(item, index, 'naver_sise_up'))
      .filter((row) => row.symbol);
  } catch {
    return [];
  }
}

async function tryNaverRiseHtml(max = 20) {
  try {
    const html = await fetchText('https://finance.naver.com/sise/sise_rise.naver?sosok=0');
    const matches = [...html.matchAll(/href="\/item\/main\.naver\?code=(\d{6})"[^>]*>([^<]+)<\/a>/g)];
    const seen = new Set();
    const rows = [];
    for (const match of matches) {
      const symbol = normalizeSymbol(match[1]);
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      rows.push({
        symbol,
        name: String(match[2] || '').trim(),
        rank: rows.length + 1,
        source: 'naver_rise_html',
      });
      if (rows.length >= max) break;
    }
    return rows;
  } catch {
    return [];
  }
}

export async function getDomesticMomentumSnapshot(symbol) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return null;

  const [mobileRows, siseRows, htmlRows] = await Promise.all([
    tryNaverMobileUp(),
    tryNaverSiseUp(),
    tryNaverRiseHtml(),
  ]);

  const candidates = [mobileRows, siseRows, htmlRows]
    .map((rows) => rows.find((row) => row.symbol === normalized))
    .filter(Boolean);

  if (!candidates.length) {
    return {
      symbol: normalized,
      found: false,
      source: null,
      rank: null,
      price: null,
      changeRate: null,
      volume: null,
    };
  }

  const best = candidates.sort((a, b) => {
    const priority = {
      naver_sise_up: 3,
      naver_mobile_up: 2,
      naver_rise_html: 1,
    };
    return (priority[b.source] || 0) - (priority[a.source] || 0);
  })[0];

  return {
    symbol: normalized,
    found: true,
    source: best.source,
    rank: Number(best.rank || null),
    price: best.price ?? null,
    changeRate: best.changeRate ?? null,
    volume: best.volume ?? null,
  };
}
