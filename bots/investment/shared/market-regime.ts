// @ts-nocheck
const CACHE_TTL_MS = 10 * 60 * 1000;
const _cache = new Map();

export const REGIMES = {
  TRENDING_BULL: 'trending_bull',
  TRENDING_BEAR: 'trending_bear',
  RANGING: 'ranging',
  VOLATILE: 'volatile',
};

export const REGIME_GUIDES = {
  [REGIMES.TRENDING_BULL]: {
    description: '강한 상승 추세',
    agentWeights: {
      aria: 1.25,
      oracle: 1.2,
      hound: 1.15,
      hera: 1.1,
      macro: 0.9,
      vibe: 0.95,
    },
    tradingStyle: 'aggressive',
    tpMultiplier: 1.3,
    slMultiplier: 1.0,
    positionSizeMultiplier: 1.2,
    timeframe: 'swing',
  },
  [REGIMES.TRENDING_BEAR]: {
    description: '강한 하락 추세',
    agentWeights: {
      macro: 1.3,
      vibe: 1.2,
      hound: 1.15,
      hera: 1.05,
      aria: 0.9,
      oracle: 0.9,
    },
    tradingStyle: 'defensive',
    tpMultiplier: 0.8,
    slMultiplier: 0.7,
    positionSizeMultiplier: 0.5,
    timeframe: 'short',
  },
  [REGIMES.RANGING]: {
    description: '횡보장',
    agentWeights: {
      echo: 1.2,
      chronos: 1.15,
      macro: 1.05,
      aria: 1.0,
      oracle: 1.0,
    },
    tradingStyle: 'neutral',
    tpMultiplier: 0.7,
    slMultiplier: 0.7,
    positionSizeMultiplier: 0.8,
    timeframe: 'short',
  },
  [REGIMES.VOLATILE]: {
    description: '급변동장',
    agentWeights: {
      macro: 1.35,
      vibe: 1.25,
      hound: 1.2,
      echo: 1.05,
      aria: 0.8,
      oracle: 0.8,
    },
    tradingStyle: 'defensive',
    tpMultiplier: 1.5,
    slMultiplier: 0.5,
    positionSizeMultiplier: 0.3,
    timeframe: 'scalp',
  },
};

const BENCHMARKS = {
  kis: [
    { symbol: '069500', label: 'KODEX200', source: 'kis_domestic', fallback: { symbol: '^KS11', source: 'yahoo' } },
    { symbol: '229200', label: 'KODEX KOSDAQ150', source: 'kis_domestic', fallback: { symbol: '^KQ11', source: 'yahoo' } },
  ],
  kis_overseas: [
    { symbol: 'QQQ', label: 'NASDAQ100 ETF', source: 'kis_overseas', fallback: { symbol: '^IXIC', source: 'yahoo' } },
    { symbol: 'AAPL', label: 'Apple', source: 'kis_overseas', fallback: { symbol: 'AAPL', source: 'yahoo' } },
    { symbol: 'MSFT', label: 'Microsoft', source: 'kis_overseas', fallback: { symbol: 'MSFT', source: 'yahoo' } },
  ],
  binance: [
    { symbol: 'BTCUSDT', label: 'BTC', source: 'binance' },
    { symbol: 'ETHUSDT', label: 'ETH', source: 'binance' },
  ],
};

function getCacheKey(market) {
  return `${market}:${new Date().toISOString().slice(0, 13)}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
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

function summarizeDailyBars(bars = []) {
  const rows = (Array.isArray(bars) ? bars : [])
    .filter((bar) => Number(bar?.close || 0) > 0)
    .sort((a, b) => String(a.date || a.timestamp || '').localeCompare(String(b.date || b.timestamp || '')));
  const lastRow = rows.at(-1);
  const prevRow = rows.at(-2) || lastRow;
  const trendBase = rows.at(-6) || rows.at(0) || lastRow;
  const last = Number(lastRow?.close || 0);
  const prev = Number(prevRow?.close || last);
  const first = Number(trendBase?.close || last);
  return {
    last,
    dayChangePct: prev > 0 ? ((last - prev) / prev) * 100 : 0,
    trendPct: first > 0 ? ((last - first) / first) * 100 : 0,
    barCount: rows.length,
    latestDate: lastRow?.date || null,
  };
}

async function fetchKisDomesticBenchmark(symbol) {
  const { getDomesticDailyPriceBars } = await import('./kis-client.ts');
  const bars = await getDomesticDailyPriceBars(symbol, { days: 20, paper: false });
  return summarizeDailyBars(bars);
}

async function fetchKisOverseasBenchmark(symbol) {
  const { getOverseasDailyPriceBars } = await import('./kis-client.ts');
  const bars = await getOverseasDailyPriceBars(symbol, { days: 20 });
  return summarizeDailyBars(bars);
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

async function fetchBenchmark(benchmark) {
  if (benchmark.source === 'binance') return fetchBinanceBenchmark(benchmark.symbol);
  if (benchmark.source === 'kis_domestic') return fetchKisDomesticBenchmark(benchmark.symbol);
  if (benchmark.source === 'kis_overseas') return fetchKisOverseasBenchmark(benchmark.symbol);
  return fetchYahooBenchmark(benchmark.symbol);
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

function summarizeScoutHint(scout = {}) {
  const signalText = String(
    scout.aiSignal
    || scout.label
    || scout.evidence
    || scout.reasoning
    || '',
  ).toLowerCase();
  const source = String(scout.source || '').toLowerCase();
  const bullKeywords = ['상승', '급등', '매수', '호재', '실적 개선', '강세'];
  const bearKeywords = ['하락', '급락', '매도', '악재', '실적 부진', '약세', '위험'];

  let sentimentShift = 0;
  const bullHits = bullKeywords.filter((keyword) => signalText.includes(keyword)).length;
  const bearHits = bearKeywords.filter((keyword) => signalText.includes(keyword)).length;
  if (bullHits > bearHits) sentimentShift += 0.1;
  if (bearHits > bullHits) sentimentShift -= 0.1;

  if (String(scout.screenerTrend || '').toLowerCase() === 'consecutive_rise') {
    sentimentShift += 0.05;
  }
  if (source === 'top10' && Number(scout.score || 0) >= 1) {
    sentimentShift += 0.05;
  }

  return {
    sentimentShift,
    summary: signalText ? `스카우트 보정 ${sentimentShift >= 0 ? '+' : ''}${sentimentShift.toFixed(2)}` : '',
  };
}

function classifyRegime(market, bias, snapshots = [], signals = {}) {
  const valid = snapshots.filter((item) => Number.isFinite(item?.dayChangePct));
  const positives = valid.filter((item) => item.dayChangePct > 0.6).length;
  const negatives = valid.filter((item) => item.dayChangePct < -0.6).length;
  const avgAbsDayChange = valid.length > 0
    ? valid.reduce((sum, item) => sum + Math.abs(Number(item.dayChangePct || 0)), 0) / valid.length
    : 0;
  const vix = valid.find((item) => item.label === 'VIX');
  const scoutHint = summarizeScoutHint(signals.scout || {});
  const adjustedBullish = bias === 'bullish' ? 1 + scoutHint.sentimentShift : scoutHint.sentimentShift;
  const adjustedBearish = bias === 'bearish' ? 1 - scoutHint.sentimentShift : -scoutHint.sentimentShift;

  if ((vix?.last || 0) >= 28 || avgAbsDayChange >= (market === 'binance' ? 4.5 : 2.2)) {
    return {
      regime: REGIMES.VOLATILE,
      confidence: clamp(Math.max(avgAbsDayChange / 6, (vix?.last || 0) / 40), 0.45, 0.92),
      guide: REGIME_GUIDES[REGIMES.VOLATILE],
      reason: `변동성 확대 (${avgAbsDayChange.toFixed(2)}%, VIX ${Number(vix?.last || 0).toFixed(1)})`,
    };
  }

  if (positives > negatives && adjustedBullish >= 0.9) {
    return {
      regime: REGIMES.TRENDING_BULL,
      confidence: clamp(0.45 + positives * 0.12 + scoutHint.sentimentShift, 0.45, 0.9),
      guide: REGIME_GUIDES[REGIMES.TRENDING_BULL],
      reason: `상승 우위 (${positives}:${negatives})${scoutHint.summary ? `, ${scoutHint.summary}` : ''}`,
    };
  }

  if (negatives > positives && adjustedBearish >= 0.9) {
    return {
      regime: REGIMES.TRENDING_BEAR,
      confidence: clamp(0.45 + negatives * 0.12 - scoutHint.sentimentShift, 0.45, 0.9),
      guide: REGIME_GUIDES[REGIMES.TRENDING_BEAR],
      reason: `하락 우위 (${negatives}:${positives})${scoutHint.summary ? `, ${scoutHint.summary}` : ''}`,
    };
  }

  return {
    regime: REGIMES.RANGING,
    confidence: clamp(0.45 + Math.abs(scoutHint.sentimentShift) * 0.2, 0.45, 0.7),
    guide: REGIME_GUIDES[REGIMES.RANGING],
    reason: `뚜렷한 추세 부재${scoutHint.summary ? `, ${scoutHint.summary}` : ''}`,
  };
}

export async function getMarketRegime(market = 'binance', signals = {}) {
  const cacheKey = getCacheKey(market);
  const cached = _cache.get(cacheKey);
  if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
    return {
      ...cached.value,
      ...classifyRegime(market, cached.value.bias, cached.value.snapshots, signals),
    };
  }

  const benchmarks = BENCHMARKS[market] || [];
  const snapshots = [];

  for (const benchmark of benchmarks) {
    try {
      const snap = await fetchBenchmark(benchmark);
      snapshots.push({ ...benchmark, ...snap });
    } catch (err) {
      if (benchmark.fallback) {
        try {
          const fallback = await fetchYahooBenchmark(benchmark.fallback.symbol);
          snapshots.push({
            ...benchmark,
            ...fallback,
            source: `${benchmark.source}_fallback_yahoo`,
            fallbackSymbol: benchmark.fallback.symbol,
            fallbackError: err.message,
          });
          continue;
        } catch (fallbackError) {
          snapshots.push({
            ...benchmark,
            error: `${err.message}; fallback failed: ${fallbackError.message}`,
            last: null,
            dayChangePct: 0,
            trendPct: 0,
          });
          continue;
        }
      }
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
  return { ...value, ...classifyRegime(market, bias, snapshots, signals) };
}

export function formatMarketRegime(regime) {
  if (!regime) return '';
  return `[시장 레짐] ${regime.market} ${regime.regime || regime.bias}\n${regime.summary}`;
}
