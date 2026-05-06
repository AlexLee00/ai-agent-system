// @ts-nocheck
// Binance public market-data adapter — crypto tier1, no auth, no trading side effects.
// Uses exchangeInfo for tradable SPOT/USDT validation and ticker/24hr for
// liquidity/momentum scoring. This reduces candidate discovery dependency on
// CoinGecko while keeping CoinGecko as an independent trend source.

import type { DiscoveryAdapter, DiscoveryCollectOptions, DiscoveryResult, DiscoverySignal } from '../types.ts';

const BINANCE_BASE = 'https://api.binance.com';
const SOURCE = 'binance_market_momentum';
const TIMEOUT_MS = 8000;

const STABLE_BASE_ASSETS = new Set([
  'USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD', 'PYUSD', 'USDP',
  'USD1', 'USDE', 'USDS', 'USDD', 'EURI', 'EUR', 'TRY', 'BRL',
]);

function clamp01(value: number, fallback = 0): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

function toCanonicalSymbol(symbol = ''): string | null {
  const raw = String(symbol || '').trim().toUpperCase();
  if (!/^[A-Z0-9]+USDT$/.test(raw) || raw.length <= 6) return null;
  return `${raw.slice(0, -4)}/USDT`;
}

function isLeveragedBase(base = ''): boolean {
  return /(?:UP|DOWN|BULL|BEAR|[235]L|[235]S)$/u.test(String(base || '').toUpperCase());
}

function isTradableUsdtSymbol(info: any): boolean {
  const base = String(info?.baseAsset || '').toUpperCase();
  if (!base || STABLE_BASE_ASSETS.has(base) || isLeveragedBase(base)) return false;
  return info?.status === 'TRADING'
    && info?.quoteAsset === 'USDT'
    && info?.isSpotTradingAllowed !== false;
}

function parseNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function scoreTicker(row: any, rank: number, btcChange: number, ethChange: number): { score: number; confidence: number; reasonCode: string; qualityFlags: string[] } {
  const quoteVolume = parseNumber(row?.quoteVolume);
  const change = parseNumber(row?.priceChangePercent);
  const trades = parseNumber(row?.count);
  const high = parseNumber(row?.highPrice);
  const low = parseNumber(row?.lowPrice);
  const last = parseNumber(row?.lastPrice);
  const range = Math.max(0, high - low);
  const rangePosition = range > 0 ? clamp01((last - low) / range, 0.5) : 0.5;
  const relativeStrength = change - Math.max(btcChange * 0.55 + ethChange * 0.45, -20);
  const liquidityScore = clamp01(Math.log10(Math.max(quoteVolume, 1)) / 10, 0);
  const tradeActivityScore = clamp01(Math.log10(Math.max(trades, 1)) / 7, 0);
  const momentumScore = clamp01((change + 8) / 24, 0);
  const relativeScore = clamp01((relativeStrength + 8) / 24, 0);
  const rangeScore = clamp01(rangePosition, 0.5);
  const rankPenalty = Math.min(0.08, rank * 0.002);
  const overheatPenalty = change >= 30 && rangePosition >= 0.92 ? 0.08 : 0;

  const score = clamp01(
    (liquidityScore * 0.30)
    + (tradeActivityScore * 0.16)
    + (momentumScore * 0.22)
    + (relativeScore * 0.22)
    + (rangeScore * 0.10)
    - rankPenalty
    - overheatPenalty,
    0.5,
  );

  const qualityFlags = [];
  if (change >= 30 && rangePosition >= 0.92) qualityFlags.push('overheated_24h_move');
  if (relativeStrength >= 5) qualityFlags.push('btc_eth_relative_strength');
  if (quoteVolume >= 50_000_000) qualityFlags.push('high_liquidity');

  return {
    score: Number(score.toFixed(4)),
    confidence: Number(clamp01((liquidityScore * 0.45) + (tradeActivityScore * 0.25) + 0.25, 0.5).toFixed(4)),
    reasonCode: relativeStrength >= 3 ? 'binance_relative_momentum' : 'binance_liquidity_momentum',
    qualityFlags,
  };
}

export class BinanceMarketMomentumCollector implements DiscoveryAdapter {
  source = SOURCE;
  market = 'crypto' as const;
  tier = 1 as const;
  reliability = 0.92;

  async collect(options: DiscoveryCollectOptions = {}): Promise<DiscoveryResult> {
    const { limit = 50, timeoutMs = TIMEOUT_MS, dryRun = false } = options;
    const fetchedAt = new Date().toISOString();

    if (process.env.LUNA_DISCOVERY_BINANCE_MARKET_ENABLED === 'false' && !dryRun) {
      return mkResult(fetchedAt, [], 'insufficient');
    }

    if (dryRun) {
      return mkResult(fetchedAt, buildMockSignals(limit), 'ready');
    }

    try {
      const [exchangeInfo, tickerRows] = await Promise.all([
        fetchJson(`${BINANCE_BASE}/api/v3/exchangeInfo?permissions=SPOT`, timeoutMs),
        fetchJson(`${BINANCE_BASE}/api/v3/ticker/24hr`, timeoutMs),
      ]);
      const tradable = new Set(
        (Array.isArray((exchangeInfo as any)?.symbols) ? (exchangeInfo as any).symbols : [])
          .filter(isTradableUsdtSymbol)
          .map((item: any) => String(item.symbol || '').toUpperCase()),
      );
      const tickers = Array.isArray(tickerRows) ? tickerRows : [];
      const btcChange = parseNumber(tickers.find((item: any) => item?.symbol === 'BTCUSDT')?.priceChangePercent);
      const ethChange = parseNumber(tickers.find((item: any) => item?.symbol === 'ETHUSDT')?.priceChangePercent);

      const filtered = tickers
        .filter((row: any) => tradable.has(String(row?.symbol || '').toUpperCase()))
        .map((row: any) => {
          const symbol = String(row?.symbol || '').toUpperCase();
          const canonical = toCanonicalSymbol(symbol);
          if (!canonical) return null;
          return {
            row,
            symbol: canonical,
            quoteVolume: parseNumber(row?.quoteVolume),
            change: parseNumber(row?.priceChangePercent),
            trades: parseNumber(row?.count),
          };
        })
        .filter(Boolean)
        .filter((item: any) => item.quoteVolume >= 750_000)
        .sort((a: any, b: any) => b.quoteVolume - a.quoteVolume)
        .slice(0, Math.max(20, Number(limit || 50) * 3));

      const signals = filtered
        .map((item: any, idx: number) => {
          const scored = scoreTicker(item.row, idx, btcChange, ethChange);
          return {
            symbol: item.symbol,
            score: scored.score,
            confidence: scored.confidence,
            reason: `Binance 24h momentum: ${item.symbol} ${item.change >= 0 ? '+' : ''}${item.change.toFixed(2)}%, volume ${(item.quoteVolume / 1_000_000).toFixed(1)}M USDT`,
            reasonCode: scored.reasonCode,
            qualityFlags: scored.qualityFlags,
            raw: {
              source: SOURCE,
              binanceSymbol: String(item.row?.symbol || '').toUpperCase(),
              quoteVolume: item.quoteVolume,
              priceChangePercent: item.change,
              tradeCount: item.trades,
              btcChange,
              ethChange,
            },
          } as DiscoverySignal;
        })
        .sort((a: DiscoverySignal, b: DiscoverySignal) => Number(b.score || 0) - Number(a.score || 0))
        .slice(0, Math.max(1, Number(limit || 50)));

      const status = signals.length >= 8 ? 'ready' : signals.length > 0 ? 'degraded' : 'insufficient';
      console.log(`[binance-market-collector] ${signals.length}개 시장 모멘텀 신호 수집`);
      return mkResult(fetchedAt, signals, status);
    } catch (error) {
      console.log(`[binance-market-collector] 수집 실패: ${error?.message || error}`);
      return mkResult(fetchedAt, [], 'insufficient');
    }
  }
}

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'LunaBinanceDiscovery/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function buildMockSignals(limit = 50): DiscoverySignal[] {
  return [
    { symbol: 'BTC/USDT', score: 0.86, confidence: 0.88, reason: 'Binance mock liquidity leader: BTC', reasonCode: 'binance_liquidity_momentum', qualityFlags: ['high_liquidity'], raw: {} },
    { symbol: 'ETH/USDT', score: 0.83, confidence: 0.86, reason: 'Binance mock liquidity leader: ETH', reasonCode: 'binance_liquidity_momentum', qualityFlags: ['high_liquidity'], raw: {} },
    { symbol: 'SOL/USDT', score: 0.79, confidence: 0.81, reason: 'Binance mock relative momentum: SOL', reasonCode: 'binance_relative_momentum', qualityFlags: ['btc_eth_relative_strength'], raw: {} },
    { symbol: 'ZEC/USDT', score: 0.74, confidence: 0.76, reason: 'Binance mock 24h momentum: ZEC', reasonCode: 'binance_relative_momentum', qualityFlags: ['overheated_24h_move'], raw: {} },
    { symbol: 'DOGE/USDT', score: 0.69, confidence: 0.74, reason: 'Binance mock activity: DOGE', reasonCode: 'binance_liquidity_momentum', qualityFlags: [], raw: {} },
  ].slice(0, Math.max(1, Number(limit || 50)));
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

export default BinanceMarketMomentumCollector;
