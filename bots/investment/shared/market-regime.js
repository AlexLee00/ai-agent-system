const CACHE_TTL_MS = 10 * 60 * 1000;
const _cache = new Map();

const BENCHMARKS = {
  kis: [
    { symbol: '^KS11', label: 'KOSPI', source: 'yahoo' },
    { symbol: '^KQ11', label: 'KOSDAQ', source: 'yahoo' },
  ],
  kis_overseas: [
    { symbol: '^GSPC', label: 'S&P500', source: 'yahoo' },
    { symbol: '^IXIC', label: 'NASDAQ', source: 'yahoo' },
    { symbol: '^VIX', label: 'VIX', source: 'yahoo' },
  ],
  binance: [
    { symbol: 'BTCUSDT', label: 'BTC', source: 'binance' },
    { symbol: 'ETHUSDT', label: 'ETH', source: 'binance' },
  ],
};

function getCacheKey(market) {
  return `${market}:${new Date().toISOString().slice(0, 13)}`;
}

async function fetchYahooBenchmark(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'luna-market-regime/1.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
  const data = await res.json();
  const result = data?.chart?.result?.[0];
  const closes = (result?.indicators?.quote?.[0]?.close || []).filter(v => Number.isFinite(v));
  const last = Number(closes.at(-1) || 0);
  const prev = Number(closes.at(-2) || closes.at(-1) || 0);
  const first = Number(closes.at(0) || last);
  const dayChangePct = prev > 0 ? ((last - prev) / prev) * 100 : 0;
  const trendPct = first > 0 ? ((last - first) / first) * 100 : 0;
  return { last, dayChangePct, trendPct };
}

async function fetchBinanceBenchmark(symbol) {
  const url = `https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'luna-market-regime/1.0' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
  const data = await res.json();
  return {
    last: Number(data?.lastPrice || 0),
    dayChangePct: Number(data?.priceChangePercent || 0),
    trendPct: Number(data?.priceChangePercent || 0),
  };
}

function summarizeBias(market, snapshots) {
  const positives = snapshots.filter(item => item.dayChangePct > 0.4).length;
  const negatives = snapshots.filter(item => item.dayChangePct < -0.4).length;
  const vix = snapshots.find(item => item.label === 'VIX');

  if (market === 'kis_overseas') {
    if ((vix?.last || 0) >= 28 || negatives >= 2) return 'bearish';
    if ((vix?.last || 0) <= 22 && positives >= 2) return 'bullish';
    return 'neutral';
  }

  if (positives > negatives) return 'bullish';
  if (negatives > positives) return 'bearish';
  return 'neutral';
}

export async function getMarketRegime(market = 'binance') {
  const cacheKey = getCacheKey(market);
  const cached = _cache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) return cached.value;

  const benchmarks = BENCHMARKS[market] || [];
  const snapshots = [];

  for (const benchmark of benchmarks) {
    try {
      const snap = benchmark.source === 'binance'
        ? await fetchBinanceBenchmark(benchmark.symbol)
        : await fetchYahooBenchmark(benchmark.symbol);
      snapshots.push({ ...benchmark, ...snap });
    } catch (err) {
      snapshots.push({ ...benchmark, error: err.message, last: null, dayChangePct: 0, trendPct: 0 });
    }
  }

  const bias = summarizeBias(market, snapshots);
  const summary = snapshots
    .map(item => {
      if (item.error) return `${item.label}: 데이터없음`;
      return `${item.label} ${item.dayChangePct >= 0 ? '+' : ''}${item.dayChangePct.toFixed(2)}% / 5d ${item.trendPct >= 0 ? '+' : ''}${item.trendPct.toFixed(2)}%`;
    })
    .join(' | ');

  const value = { market, bias, summary, snapshots };
  _cache.set(cacheKey, { ts: Date.now(), value });
  return value;
}

export function formatMarketRegime(regime) {
  if (!regime) return '';
  return `[시장 레짐] ${regime.market} ${regime.bias}\n${regime.summary}`;
}

