// @ts-nocheck
// Binance Spot USDT quoteVolume top-volume universe gate.
// Read-only market-data helper; no account, order, or secret side effects.

const BINANCE_BASE = 'https://api.binance.com';

// 'top'으로 일반화 (이전 'top30'). 유니버스 크기는 LUNA_BINANCE_TOP_VOLUME_LIMIT env로 가변하므로
// 문자열에서 숫자를 뺀 것은 의도임. 매칭 측은 신규+레거시('top30')를 병기해 하위호환 유지.
export const BINANCE_TOP_VOLUME_SOURCE = 'binance_spot_usdt_quote_volume_top';
export const BINANCE_TOP_VOLUME_BLOCK_REASON = 'outside_binance_top_volume_universe';
// 유니버스 크기를 env로 가변화 (기본 30, 운영 50). 기존엔 fixedLimit()이 30을 하드 고정했음.
export const DEFAULT_BINANCE_TOP_VOLUME_LIMIT = Math.max(1, Number(process.env.LUNA_BINANCE_TOP_VOLUME_LIMIT) || 30);
export const DEFAULT_BINANCE_TOP_VOLUME_QUOTE = 'USDT';

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

const STABLE_OR_FIAT_BASE_ASSETS = new Set([
  'USDT', 'USDC', 'BUSD', 'DAI', 'TUSD', 'FDUSD', 'PYUSD', 'USDP',
  'USD1', 'USDE', 'USDS', 'USDD', 'RLUSD', 'XUSD', 'EURI', 'EUR',
  'TRY', 'BRL', 'BIDR', 'IDRT', 'UAH', 'ZAR', 'NGN', 'RUB', 'GBP',
  'AUD', 'JPY',
]);

const LEVERAGED_BASE_ASSETS = new Set([
  'BTCUP', 'BTCDOWN', 'ETHUP', 'ETHDOWN', 'BNBUP', 'BNBDOWN',
  'XRPUP', 'XRPDOWN', 'ADAUP', 'ADADOWN', 'LINKUP', 'LINKDOWN',
  'DOTUP', 'DOTDOWN', 'LTCUP', 'LTCDOWN', 'BCHUP', 'BCHDOWN',
  'UNIUP', 'UNIDOWN', 'SUSHIUP', 'SUSHIDOWN', 'AAVEUP', 'AAVEDOWN',
  'YFIUP', 'YFIDOWN', 'FILUP', 'FILDOWN', 'EOSUP', 'EOSDOWN',
  'TRXUP', 'TRXDOWN', 'XTZUP', 'XTZDOWN',
]);

let cachedUniverse = null;

// 유니버스 크기 결정. 호출자가 limit을 명시하면 그 값을, 아니면 env 기반 DEFAULT(기본30/운영50)를 사용.
// 과거엔 입력을 무시하고 30을 하드 고정했으나, env 가변화에 맞춰 입력·DEFAULT를 존중하도록 변경.
function fixedLimit(value = DEFAULT_BINANCE_TOP_VOLUME_LIMIT) {
  const parsed = Number(value || DEFAULT_BINANCE_TOP_VOLUME_LIMIT);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_BINANCE_TOP_VOLUME_LIMIT;
  return Math.floor(parsed);
}

function normalizedQuote(value = DEFAULT_BINANCE_TOP_VOLUME_QUOTE) {
  const quote = String(value || DEFAULT_BINANCE_TOP_VOLUME_QUOTE).trim().toUpperCase();
  return quote || DEFAULT_BINANCE_TOP_VOLUME_QUOTE;
}

function parseNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function normalizeBinanceUsdtSymbol(symbol = '', quote = DEFAULT_BINANCE_TOP_VOLUME_QUOTE) {
  const targetQuote = normalizedQuote(quote);
  const raw = String(symbol || '').trim().toUpperCase();
  if (!raw) return null;
  if (raw.includes('/')) {
    const [base, q] = raw.split('/');
    if (!base || q !== targetQuote) return null;
    return `${base}/${targetQuote}`;
  }
  if (raw.endsWith(targetQuote) && raw.length > targetQuote.length) {
    return `${raw.slice(0, -targetQuote.length)}/${targetQuote}`;
  }
  return null;
}

export function baseAssetFromCanonicalSymbol(symbol = '') {
  const canonical = normalizeBinanceUsdtSymbol(symbol);
  return canonical ? canonical.split('/')[0] : '';
}

export function isStableOrFiatBaseAsset(base = '') {
  return STABLE_OR_FIAT_BASE_ASSETS.has(String(base || '').trim().toUpperCase());
}

export function isLeveragedBaseAsset(base = '') {
  const normalized = String(base || '').trim().toUpperCase();
  return LEVERAGED_BASE_ASSETS.has(normalized) || /(?:BULL|BEAR|[235]L|[235]S)$/u.test(normalized);
}

export function isEligibleBinanceTopVolumeInfo(info = {}, quote = DEFAULT_BINANCE_TOP_VOLUME_QUOTE) {
  const targetQuote = normalizedQuote(quote);
  const base = String(info?.baseAsset || '').trim().toUpperCase();
  if (!base || isStableOrFiatBaseAsset(base) || isLeveragedBaseAsset(base)) return false;
  return info?.status === 'TRADING'
    && String(info?.quoteAsset || '').toUpperCase() === targetQuote
    && info?.isSpotTradingAllowed !== false;
}

export function buildBinanceTopVolumeUniverse({
  exchangeInfo = {},
  tickerRows = [],
  limit = DEFAULT_BINANCE_TOP_VOLUME_LIMIT,
  quote = DEFAULT_BINANCE_TOP_VOLUME_QUOTE,
  fetchedAt = new Date().toISOString(),
} = {}) {
  const targetQuote = normalizedQuote(quote);
  const resolvedLimit = fixedLimit(limit);
  const symbolsInfo = Array.isArray(exchangeInfo?.symbols) ? exchangeInfo.symbols : [];
  const excluded = {
    stableOrFiat: [],
    leveraged: [],
    nonUsdtSpot: [],
    nonTrading: [],
    invalidTicker: [],
  };
  const tradable = new Map();

  for (const info of symbolsInfo) {
    const rawSymbol = String(info?.symbol || '').trim().toUpperCase();
    const canonical = normalizeBinanceUsdtSymbol(rawSymbol, targetQuote);
    const base = String(info?.baseAsset || '').trim().toUpperCase();
    if (!canonical) {
      if (rawSymbol) excluded.nonUsdtSpot.push(rawSymbol);
      continue;
    }
    if (isStableOrFiatBaseAsset(base)) {
      excluded.stableOrFiat.push(canonical);
      continue;
    }
    if (isLeveragedBaseAsset(base)) {
      excluded.leveraged.push(canonical);
      continue;
    }
    if (!isEligibleBinanceTopVolumeInfo(info, targetQuote)) {
      excluded.nonTrading.push(canonical);
      continue;
    }
    tradable.set(rawSymbol, { canonical, base });
  }

  const ranked = (Array.isArray(tickerRows) ? tickerRows : [])
    .map((row) => {
      const rawSymbol = String(row?.symbol || '').trim().toUpperCase();
      const info = tradable.get(rawSymbol);
      if (!info) return null;
      const quoteVolume = parseNumber(row?.quoteVolume, NaN);
      if (!Number.isFinite(quoteVolume) || quoteVolume <= 0) {
        excluded.invalidTicker.push(info.canonical);
        return null;
      }
      return {
        symbol: info.canonical,
        binanceSymbol: rawSymbol,
        baseAsset: info.base,
        quoteVolume,
        priceChangePercent: parseNumber(row?.priceChangePercent),
        tradeCount: parseNumber(row?.count),
        lastPrice: parseNumber(row?.lastPrice),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, resolvedLimit);

  const ranks = {};
  ranked.forEach((row, index) => {
    ranks[row.symbol] = index + 1;
  });

  return {
    source: BINANCE_TOP_VOLUME_SOURCE,
    fetchedAt,
    quote: targetQuote,
    limit: resolvedLimit,
    symbols: ranked.map((row) => row.symbol),
    ranks,
    rows: ranked,
    excluded: {
      stableOrFiat: [...new Set(excluded.stableOrFiat)],
      leveraged: [...new Set(excluded.leveraged)],
      nonUsdtSpotCount: excluded.nonUsdtSpot.length,
      nonTradingCount: excluded.nonTrading.length,
      invalidTicker: [...new Set(excluded.invalidTicker)],
    },
  };
}

export function buildFixtureBinanceTopVolumeUniverse({ limit = DEFAULT_BINANCE_TOP_VOLUME_LIMIT } = {}) {
  const bases = [
    'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'TRX', 'LINK', 'AVAX',
    'SUI', 'LTC', 'TON', 'DOT', 'BCH', 'UNI', 'APT', 'NEAR', 'ICP', 'ETC',
    'FIL', 'ARB', 'OP', 'ATOM', 'INJ', 'RENDER', 'SEI', 'TIA', 'JUP', 'WIF',
    'PEPE', 'FLOKI', 'BONK', 'AAVE', 'MKR',
  ];
  const exchangeInfo = {
    symbols: [
      ...bases.map((base) => ({
        symbol: `${base}USDT`,
        baseAsset: base,
        quoteAsset: 'USDT',
        status: 'TRADING',
        isSpotTradingAllowed: true,
      })),
      { symbol: 'USDCUSDT', baseAsset: 'USDC', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true },
      { symbol: 'BTCUPUSDT', baseAsset: 'BTCUP', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true },
    ],
  };
  const tickerRows = bases.map((base, index) => ({
    symbol: `${base}USDT`,
    quoteVolume: String(10_000_000_000 - index * 100_000_000),
    priceChangePercent: String(5 - index * 0.1),
    count: String(1_000_000 - index * 1000),
    lastPrice: String(100 - index),
  })).concat([
    { symbol: 'USDCUSDT', quoteVolume: '999999999999', priceChangePercent: '0', count: '1', lastPrice: '1' },
    { symbol: 'BTCUPUSDT', quoteVolume: '888888888888', priceChangePercent: '0', count: '1', lastPrice: '1' },
  ]);
  return buildBinanceTopVolumeUniverse({ exchangeInfo, tickerRows, limit, quote: 'USDT' });
}

async function fetchJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'LunaBinanceTopVolumeUniverse/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchBinanceTopVolumeUniverse(options = {}) {
  const limit = fixedLimit(options.limit);
  const quote = normalizedQuote(options.quote);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  if (options.dryRun || options.fixture) return buildFixtureBinanceTopVolumeUniverse({ limit });

  const [exchangeInfo, tickerRows] = await Promise.all([
    fetchJson(`${BINANCE_BASE}/api/v3/exchangeInfo?permissions=SPOT`, timeoutMs),
    fetchJson(`${BINANCE_BASE}/api/v3/ticker/24hr`, timeoutMs),
  ]);
  return buildBinanceTopVolumeUniverse({ exchangeInfo, tickerRows, limit, quote });
}

export async function getCachedBinanceTopVolumeUniverse(options = {}) {
  const now = Date.now();
  const ttlMs = Math.max(1_000, Number(options.ttlMs || DEFAULT_CACHE_TTL_MS));
  if (!options.refresh && cachedUniverse && (now - cachedUniverse.cachedAtMs) < ttlMs) {
    return cachedUniverse.value;
  }
  const value = await fetchBinanceTopVolumeUniverse(options);
  cachedUniverse = { cachedAtMs: now, value };
  return value;
}

export function evaluateBinanceTopVolumeUniverseGate(symbol, universe = null) {
  const canonical = normalizeBinanceUsdtSymbol(symbol);
  if (!canonical) {
    return {
      ok: false,
      blocked: true,
      reason: 'invalid_binance_usdt_symbol',
      code: 'invalid_binance_usdt_symbol',
      symbol: String(symbol || ''),
      canonicalSymbol: null,
      rank: null,
      limit: universe?.limit || DEFAULT_BINANCE_TOP_VOLUME_LIMIT,
    };
  }
  const rank = universe?.ranks?.[canonical] || null;
  const ok = Number(rank || 0) >= 1 && Number(rank || 0) <= Number(universe?.limit || DEFAULT_BINANCE_TOP_VOLUME_LIMIT);
  return {
    ok,
    blocked: !ok,
    // 'top'으로 일반화 (이전 'top30'). 유니버스 크기는 env 가변. 숫자 제거는 의도.
    reason: ok ? 'in_binance_top_volume_universe' : BINANCE_TOP_VOLUME_BLOCK_REASON,
    code: ok ? 'in_binance_top_volume_universe' : BINANCE_TOP_VOLUME_BLOCK_REASON,
    symbol: canonical,
    canonicalSymbol: canonical,
    rank,
    limit: universe?.limit || DEFAULT_BINANCE_TOP_VOLUME_LIMIT,
    source: universe?.source || BINANCE_TOP_VOLUME_SOURCE,
    fetchedAt: universe?.fetchedAt || null,
  };
}

export function filterSymbolsByBinanceTopVolumeUniverse(symbols = [], universe = null) {
  const allowed = [];
  const excluded = [];
  for (const symbol of Array.isArray(symbols) ? symbols : []) {
    const gate = evaluateBinanceTopVolumeUniverseGate(symbol, universe);
    if (gate.ok) allowed.push(gate.canonicalSymbol);
    else excluded.push({ symbol, canonicalSymbol: gate.canonicalSymbol, reason: gate.reason, rank: gate.rank });
  }
  return { symbols: [...new Set(allowed)], excluded };
}

export default {
  BINANCE_TOP_VOLUME_BLOCK_REASON,
  DEFAULT_BINANCE_TOP_VOLUME_LIMIT,
  fetchBinanceTopVolumeUniverse,
  getCachedBinanceTopVolumeUniverse,
  buildBinanceTopVolumeUniverse,
  buildFixtureBinanceTopVolumeUniverse,
  evaluateBinanceTopVolumeUniverseGate,
  filterSymbolsByBinanceTopVolumeUniverse,
  normalizeBinanceUsdtSymbol,
};
