// @ts-nocheck
// CoinGecko 트렌딩 어댑터 — crypto tier1, 신뢰도 0.85, 무료 API
// CoinGecko /trending → 시장에서 검색량 급등 코인 수집
// 무료 API (x-cg-demo-api-key 권장) — Rate limit: 30회/분
// Kill switch: LUNA_DISCOVERY_DART (범용 kill switch 사용, crypto별 별도 없음)
//   → LUNA_DISCOVERY_ORCHESTRATOR_ENABLED=false 시 orchestrator가 호출 안 함

import type { DiscoveryAdapter, DiscoveryResult, DiscoveryCollectOptions, DiscoverySignal } from '../types.ts';

const COINGECKO_BASE = 'https://api.coingecko.com/api/v3';
const SOURCE = 'coingecko_trending';
const TIMEOUT_MS = 5000;
const RETRY_MAX = 1;

// Binance 거래 가능 USDT 페어로 변환 (CoinGecko symbol → Binance symbol)
const KNOWN_SYMBOL_MAP: Record<string, string> = {
  BTC: 'BTCUSDT', ETH: 'ETHUSDT', SOL: 'SOLUSDT', BNB: 'BNBUSDT',
  XRP: 'XRPUSDT', ADA: 'ADAUSDT', DOGE: 'DOGEUSDT', AVAX: 'AVAXUSDT',
  MATIC: 'MATICUSDT', LINK: 'LINKUSDT', DOT: 'DOTUSDT', UNI: 'UNIUSDT',
  LTC: 'LTCUSDT', ATOM: 'ATOMUSDT', FIL: 'FILUSDT', NEAR: 'NEARUSDT',
  APT: 'APTUSDT', ARB: 'ARBUSDT', OP: 'OPUSDT', SUI: 'SUIUSDT',
  TIA: 'TIAUSDT', JUP: 'JUPUSDT', WIF: 'WIFUSDT', PEPE: 'PEPEUSDT',
  FLOKI: 'FLOKIUSDT', BONK: 'BONKUSDT', SEI: 'SEIUSDT', INJ: 'INJUSDT',
  FET: 'FETUSDT', RENDER: 'RENDERUSDT', TAO: 'TAOUSDT',
};

export class CoinGeckoTrendingCollector implements DiscoveryAdapter {
  source = SOURCE;
  market = 'crypto' as const;
  tier = 1 as const;
  reliability = 0.85;

  private apiKey: string;

  constructor() {
    this.apiKey = process.env.COINGECKO_API_KEY || '';
  }

  async collect(options: DiscoveryCollectOptions = {}): Promise<DiscoveryResult> {
    const { limit = 50, timeoutMs = TIMEOUT_MS, dryRun = false } = options;
    const fetchedAt = new Date().toISOString();

    if (dryRun) {
      return mkResult(fetchedAt, buildMockSignals(), 'ready');
    }

    for (let attempt = 0; attempt <= RETRY_MAX; attempt++) {
      try {
        const signals = await Promise.allSettled([
          this.fetchTrending(timeoutMs),
          this.fetchTopGainers(timeoutMs),
        ]).then(([trendingR, gainersR]) => {
          const trending = trendingR.status === 'fulfilled' ? trendingR.value : [];
          const gainers = gainersR.status === 'fulfilled' ? gainersR.value : [];
          return mergeAndDedupe([...trending, ...gainers], limit);
        });

        const status = signals.length >= 5 ? 'ready' : signals.length > 0 ? 'degraded' : 'insufficient';
        console.log(`[coingecko-collector] ${signals.length}개 트렌딩 신호 수집`);
        return mkResult(fetchedAt, signals, status);
      } catch (err) {
        if (attempt === RETRY_MAX) {
          console.log(`[coingecko-collector] 수집 실패 (시도 ${attempt + 1}): ${err?.message}`);
          return mkResult(fetchedAt, [], 'insufficient');
        }
        await sleep(1500);
      }
    }

    return mkResult(fetchedAt, [], 'insufficient');
  }

  private async fetchTrending(timeoutMs: number): Promise<DiscoverySignal[]> {
    const url = `${COINGECKO_BASE}/search/trending`;
    const data = await fetchWithTimeout(url, timeoutMs, this.apiKey);
    const coins: unknown[] = (data as any)?.coins || [];

    return coins
      .map((c: unknown, idx: number) => {
        const item = (c as any)?.item;
        if (!item) return null;
        const cgSymbol = String(item.symbol || '').toUpperCase();
        const binanceSymbol = KNOWN_SYMBOL_MAP[cgSymbol];
        if (!binanceSymbol) return null;

        // 트렌딩 순위 기반 점수 (1위=0.88, 순위 내려갈수록 감소)
        const score = Math.max(0.60, 0.88 - idx * 0.025);
        return {
          symbol: binanceSymbol,
          score,
          reason: `CoinGecko 트렌딩 #${idx + 1}: ${item.name} (${cgSymbol})`,
          raw: { rank: idx + 1, name: item.name, cg_id: item.id, price_btc: item.price_btc },
        } as DiscoverySignal;
      })
      .filter(Boolean) as DiscoverySignal[];
  }

  private async fetchTopGainers(timeoutMs: number): Promise<DiscoverySignal[]> {
    // Top gainers — 24h 등락률 상위 (무료 API 엔드포인트)
    const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&order=percent_change_24h_desc&per_page=30&page=1&price_change_percentage=24h`;
    const data = await fetchWithTimeout(url, timeoutMs, this.apiKey);
    if (!Array.isArray(data)) return [];

    return (data as unknown[])
      .map((c: unknown) => {
        const coin = c as Record<string, unknown>;
        const cgSymbol = String(coin.symbol || '').toUpperCase();
        const binanceSymbol = KNOWN_SYMBOL_MAP[cgSymbol];
        if (!binanceSymbol) return null;

        const change24h = Number(coin.price_change_percentage_24h || 0);
        if (change24h < 5) return null;  // 5% 미만 등락 필터

        // 등락률 → 점수 (5%=0.62, 20%+=0.80)
        const score = Math.min(0.80, 0.62 + (change24h - 5) * 0.012);
        return {
          symbol: binanceSymbol,
          score,
          reason: `CoinGecko 24h 급등 +${change24h.toFixed(1)}%: ${coin.name}`,
          raw: { change24h, marketCap: coin.market_cap, volume24h: coin.total_volume },
        } as DiscoverySignal;
      })
      .filter(Boolean) as DiscoverySignal[];
  }
}

async function fetchWithTimeout(url: string, timeoutMs: number, apiKey: string): Promise<unknown> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const headers: Record<string, string> = { 'User-Agent': 'LunaDiscovery/1.0' };
  if (apiKey) headers['x-cg-demo-api-key'] = apiKey;

  try {
    const res = await fetch(url, { signal: ac.signal, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function mergeAndDedupe(signals: DiscoverySignal[], limit: number): DiscoverySignal[] {
  const seen = new Map<string, DiscoverySignal>();
  for (const s of signals) {
    const prev = seen.get(s.symbol);
    if (!prev || s.score > prev.score) seen.set(s.symbol, s);
  }
  return Array.from(seen.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function buildMockSignals(): DiscoverySignal[] {
  return [
    { symbol: 'BTCUSDT', score: 0.88, reason: 'CoinGecko mock 트렌딩 #1: Bitcoin', raw: {} },
    { symbol: 'ETHUSDT', score: 0.86, reason: 'CoinGecko mock 트렌딩 #2: Ethereum', raw: {} },
    { symbol: 'SOLUSDT', score: 0.84, reason: 'CoinGecko mock 트렌딩 #3: Solana', raw: {} },
    { symbol: 'ARBUSDT', score: 0.75, reason: 'CoinGecko mock 24h 급등 +12.3%', raw: {} },
    { symbol: 'OPUSDT',  score: 0.70, reason: 'CoinGecko mock 24h 급등 +8.1%',  raw: {} },
  ];
}

function mkResult(
  fetchedAt: string,
  signals: DiscoverySignal[],
  status: 'ready' | 'degraded' | 'insufficient',
): DiscoveryResult {
  return {
    source: SOURCE,
    market: 'crypto',
    fetchedAt,
    signals,
    quality: { status, sourceTier: 1, signalCount: signals.length },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export default CoinGeckoTrendingCollector;
