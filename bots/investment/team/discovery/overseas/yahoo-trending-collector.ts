// @ts-nocheck
import type { DiscoveryAdapter, DiscoveryCollectOptions, DiscoveryResult, DiscoverySignal } from '../types.ts';

const SOURCE = 'yahoo_trending';
const DEFAULT_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'META', 'GOOGL', 'AMD', 'NFLX', 'AVGO'];

function uniq(list = []) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const symbol = String(item || '').trim().toUpperCase();
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);
    out.push(symbol);
  }
  return out;
}

function buildMockSignals(limit = 20): DiscoverySignal[] {
  const rows = DEFAULT_SYMBOLS.slice(0, limit);
  return rows.map((symbol, idx) => ({
    symbol,
    score: Math.max(0.6, 0.86 - idx * 0.02),
    confidence: Math.max(0.58, 0.82 - idx * 0.02),
    reason: `Yahoo trending mock #${idx + 1}`,
    reasonCode: 'yahoo_trending',
    evidenceRef: { rank: idx + 1 },
    qualityFlags: ['market_open_reference'],
    raw: {},
  }));
}

export class YahooTrendingCollector implements DiscoveryAdapter {
  source = SOURCE;
  market = 'overseas' as const;
  tier = 1 as const;
  reliability = 0.8;

  async collect(options: DiscoveryCollectOptions = {}): Promise<DiscoveryResult> {
    const fetchedAt = new Date().toISOString();
    const { limit = 30, dryRun = false } = options;

    if (process.env.LUNA_DISCOVERY_YAHOO !== 'true' && !dryRun) {
      return mkResult(fetchedAt, [], 'insufficient');
    }

    if (dryRun) return mkResult(fetchedAt, buildMockSignals(limit), 'ready');

    try {
      const rows = await fetchYahooTrending(limit);
      if (rows.length <= 0) return mkResult(fetchedAt, [], 'insufficient');
      const signals = rows.map((symbol, idx) => ({
        symbol,
        score: Math.max(0.58, 0.82 - idx * 0.018),
        confidence: Math.max(0.52, 0.78 - idx * 0.017),
        reason: `Yahoo most-active ${symbol}`,
        reasonCode: 'yahoo_most_active',
        evidenceRef: { rank: idx + 1 },
        qualityFlags: ['market_activity'],
        raw: {},
      }));
      return mkResult(fetchedAt, signals, signals.length >= 5 ? 'ready' : 'degraded');
    } catch (error) {
      console.warn(`[yahoo-trending-collector] failed: ${error?.message || error}`);
      return mkResult(fetchedAt, [], 'insufficient');
    }
  }
}

async function fetchYahooTrending(limit = 30) {
  const url = 'https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?formatted=true&scrIds=most_actives&count=50&start=0';
  const res = await fetch(url, {
    headers: { 'User-Agent': 'LunaDiscovery/1.0' },
    signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const payload = await res.json();
  const quotes = payload?.finance?.result?.[0]?.quotes || [];
  const symbols = uniq(quotes.map((item) => item?.symbol)).slice(0, Math.max(1, limit));
  return symbols;
}

function mkResult(
  fetchedAt: string,
  signals: DiscoverySignal[],
  status: 'ready' | 'degraded' | 'insufficient',
): DiscoveryResult {
  return {
    source: SOURCE,
    market: 'overseas',
    fetchedAt,
    signals,
    quality: {
      status,
      sourceTier: 1,
      signalCount: signals.length,
    },
  };
}

export default YahooTrendingCollector;
