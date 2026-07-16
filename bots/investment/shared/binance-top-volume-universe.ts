// @ts-nocheck
// Binance Spot USDT quoteVolume Top 30 universe gate.
// Read-only market-data helper; no account, order, or secret side effects.

const BINANCE_BASE = 'https://api.binance.com';

export const BINANCE_TOP_VOLUME_SOURCE = 'binance_spot_usdt_quote_volume_top30';
export const BINANCE_TOP_VOLUME_LEGACY_BLOCK_REASON = 'outside_binance_top30_volume_universe';
export const BINANCE_MAJOR_UNIVERSE_SOURCE = 'coingecko_market_cap_binance_usdt_major20';
export const BINANCE_MAJOR_UNIVERSE_BLOCK_REASON = 'outside_binance_major_universe';
export const BINANCE_MAJOR_WHITELIST_SOURCE = Object.freeze({
  provider: 'CoinGecko /api/v3/coins/markets',
  snapshotAt: '2026-07-16T13:08:37.000Z',
  quote: 'USD market cap',
});
export const DEFAULT_BINANCE_MAJOR_WHITELIST = Object.freeze([
  'BTC/USDT', 'ETH/USDT', 'BNB/USDT', 'XRP/USDT', 'SOL/USDT',
  'TRX/USDT', 'DOGE/USDT', 'ZEC/USDT', 'XLM/USDT', 'LINK/USDT',
  'ADA/USDT', 'BCH/USDT', 'LTC/USDT', 'SUI/USDT', 'HBAR/USDT',
  'AVAX/USDT', 'NEAR/USDT', 'SHIB/USDT', 'UNI/USDT', 'TAO/USDT',
]);
export const DEFAULT_BINANCE_TOP_VOLUME_LIMIT = 30;
export const DEFAULT_BINANCE_TOP_VOLUME_QUOTE = 'USDT';
export const DEFAULT_BINANCE_MAJOR_UNIVERSE_LIMIT = 20;

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
const MAJOR_ADDITIONAL_EXCLUDED_BASE_ASSETS = new Set([
  'XAUT', 'PAXG', 'USD0', 'USDTB', 'SUSDS', 'SUSDE', 'BFUSD', 'U',
]);

let cachedUniverse = null;

export function resolveCryptoUniverseMode({ env = process.env } = {}) {
  const raw = String(env?.LUNA_CRYPTO_UNIVERSE_MODE ?? 'major').trim().toLowerCase();
  if (raw === 'major' || raw === 'top_volume') return { mode: raw, valid: true, raw };
  return { mode: 'major', valid: false, raw, reason: 'invalid_crypto_universe_mode' };
}

function normalizeMajorWhitelistSymbol(value = '') {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return null;
  if (/^[A-Z0-9]+$/u.test(raw) && !raw.endsWith('USDT')) return `${raw}/USDT`;
  return normalizeBinanceUsdtSymbol(raw);
}

export function isMajorExcludedBaseAsset(base = '') {
  const normalized = String(base || '').trim().toUpperCase();
  return isStableOrFiatBaseAsset(normalized)
    || isLeveragedBaseAsset(normalized)
    || MAJOR_ADDITIONAL_EXCLUDED_BASE_ASSETS.has(normalized);
}

export function parseBinanceMajorWhitelist({ env = process.env, value } = {}) {
  const explicitlyConfigured = value !== undefined
    || Object.prototype.hasOwnProperty.call(env || {}, 'LUNA_CRYPTO_MAJOR_WHITELIST');
  const raw = value !== undefined ? value : env?.LUNA_CRYPTO_MAJOR_WHITELIST;
  const tokens = explicitlyConfigured
    ? String(raw ?? '').split(',').map((item) => item.trim()).filter(Boolean)
    : [...DEFAULT_BINANCE_MAJOR_WHITELIST];
  if (!tokens.length) {
    return { valid: false, symbols: [], source: 'env', reason: 'major_whitelist_empty' };
  }
  const symbols = tokens.map(normalizeMajorWhitelistSymbol);
  if (symbols.some((symbol) => !symbol)) {
    return { valid: false, symbols: [], source: explicitlyConfigured ? 'env' : 'default', reason: 'major_whitelist_invalid_symbol' };
  }
  if (new Set(symbols).size !== symbols.length) {
    return { valid: false, symbols: [], source: explicitlyConfigured ? 'env' : 'default', reason: 'major_whitelist_duplicate_symbol' };
  }
  if (symbols.length !== DEFAULT_BINANCE_MAJOR_UNIVERSE_LIMIT) {
    return {
      valid: false,
      symbols: [],
      source: explicitlyConfigured ? 'env' : 'default',
      reason: 'major_whitelist_requires_exactly_20_symbols',
      observedCount: symbols.length,
    };
  }
  const structurallyExcluded = symbols.filter((symbol) => isMajorExcludedBaseAsset(baseAssetFromCanonicalSymbol(symbol)));
  if (structurallyExcluded.length) {
    return {
      valid: false,
      symbols: [],
      source: explicitlyConfigured ? 'env' : 'default',
      reason: 'major_whitelist_contains_excluded_asset',
      invalidSymbols: structurallyExcluded,
    };
  }
  return {
    valid: true,
    symbols,
    source: explicitlyConfigured ? 'env' : 'default',
    reason: null,
  };
}

function fixedLimit(value = DEFAULT_BINANCE_TOP_VOLUME_LIMIT) {
  const parsed = Number(value || DEFAULT_BINANCE_TOP_VOLUME_LIMIT);
  if (!Number.isFinite(parsed)) return DEFAULT_BINANCE_TOP_VOLUME_LIMIT;
  return DEFAULT_BINANCE_TOP_VOLUME_LIMIT;
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

function unavailableMajorUniverse({
  whitelistResult,
  invalidSymbols = [],
  reason = 'binance_major_universe_unavailable',
  fetchedAt = new Date().toISOString(),
} = {}) {
  return {
    source: BINANCE_MAJOR_UNIVERSE_SOURCE,
    whitelistSource: BINANCE_MAJOR_WHITELIST_SOURCE,
    fetchedAt,
    quote: 'USDT',
    limit: DEFAULT_BINANCE_MAJOR_UNIVERSE_LIMIT,
    mode: 'major',
    available: false,
    failClosed: true,
    warning: reason,
    whitelistSourceType: whitelistResult?.source || null,
    configuredSymbols: whitelistResult?.symbols || [],
    invalidSymbols,
    symbols: [],
    ranks: {},
    rows: [],
    excluded: { invalidSymbols },
  };
}

export function buildBinanceMajorUniverse({
  exchangeInfo = {},
  whitelistResult = parseBinanceMajorWhitelist(),
  fetchedAt = new Date().toISOString(),
} = {}) {
  if (!whitelistResult?.valid) {
    return unavailableMajorUniverse({
      whitelistResult,
      reason: whitelistResult?.reason || 'major_whitelist_invalid',
      fetchedAt,
    });
  }
  const infoByCanonical = new Map();
  for (const info of Array.isArray(exchangeInfo?.symbols) ? exchangeInfo.symbols : []) {
    const canonical = normalizeBinanceUsdtSymbol(info?.symbol);
    if (canonical) infoByCanonical.set(canonical, info);
  }
  const invalidSymbols = [];
  for (const symbol of whitelistResult.symbols) {
    const info = infoByCanonical.get(symbol);
    const base = baseAssetFromCanonicalSymbol(symbol);
    const reasons = [];
    if (!info) reasons.push('not_listed');
    if (info && info.status !== 'TRADING') reasons.push('not_trading');
    if (info && String(info.quoteAsset || '').toUpperCase() !== 'USDT') reasons.push('not_usdt_quote');
    if (info && info.isSpotTradingAllowed !== true) reasons.push('spot_trading_not_confirmed');
    if (isMajorExcludedBaseAsset(base)) reasons.push('structurally_excluded');
    if (reasons.length) invalidSymbols.push({ symbol, reasons });
  }
  if (invalidSymbols.length) {
    return unavailableMajorUniverse({
      whitelistResult,
      invalidSymbols,
      reason: 'major_whitelist_exchange_validation_failed',
      fetchedAt,
    });
  }
  const rows = whitelistResult.symbols.map((symbol, index) => ({
    symbol,
    binanceSymbol: symbol.replace('/', ''),
    baseAsset: baseAssetFromCanonicalSymbol(symbol),
    whitelistRank: index + 1,
  }));
  return {
    source: BINANCE_MAJOR_UNIVERSE_SOURCE,
    whitelistSource: BINANCE_MAJOR_WHITELIST_SOURCE,
    whitelistSourceType: whitelistResult.source,
    fetchedAt,
    quote: 'USDT',
    limit: DEFAULT_BINANCE_MAJOR_UNIVERSE_LIMIT,
    mode: 'major',
    available: true,
    failClosed: false,
    warning: null,
    invalidSymbols: [],
    symbols: rows.map((row) => row.symbol),
    ranks: Object.fromEntries(rows.map((row) => [row.symbol, row.whitelistRank])),
    rows,
    excluded: { invalidSymbols: [] },
  };
}

export function buildFixtureBinanceMajorUniverse(options = {}) {
  const whitelistResult = options.whitelistResult || parseBinanceMajorWhitelist({ env: {} });
  const exchangeInfo = {
    symbols: whitelistResult.symbols.map((symbol) => ({
      symbol: symbol.replace('/', ''),
      baseAsset: baseAssetFromCanonicalSymbol(symbol),
      quoteAsset: 'USDT',
      status: 'TRADING',
      isSpotTradingAllowed: true,
    })),
  };
  return buildBinanceMajorUniverse({ exchangeInfo, whitelistResult, fetchedAt: options.fetchedAt });
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

function warnMajorUniverse(universe, warnFn = console.error) {
  if (universe?.available !== false || typeof warnFn !== 'function') return;
  const invalid = (universe.invalidSymbols || []).map((item) => item.symbol).join(',');
  warnFn(`[LUNA][CRITICAL] Binance major universe fail-closed: ${universe.warning}${invalid ? ` invalid=${invalid}` : ''}`);
}

export async function fetchBinanceTopVolumeUniverse(options = {}) {
  const modeResult = resolveCryptoUniverseMode({ env: options.env || process.env });
  if (!modeResult.valid) {
    const universe = unavailableMajorUniverse({
      whitelistResult: { valid: false, symbols: [], source: 'env', reason: modeResult.reason },
      reason: modeResult.reason,
    });
    warnMajorUniverse(universe, options.warnFn);
    return universe;
  }
  const limit = fixedLimit(options.limit);
  const quote = normalizedQuote(options.quote);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  if (modeResult.mode === 'top_volume') {
    if (options.dryRun || options.fixture) return buildFixtureBinanceTopVolumeUniverse({ limit });

    const [exchangeInfo, tickerRows] = await Promise.all([
      fetchJson(`${BINANCE_BASE}/api/v3/exchangeInfo?permissions=SPOT`, timeoutMs),
      fetchJson(`${BINANCE_BASE}/api/v3/ticker/24hr`, timeoutMs),
    ]);
    return buildBinanceTopVolumeUniverse({ exchangeInfo, tickerRows, limit, quote });
  }

  const whitelistResult = parseBinanceMajorWhitelist({ env: options.env || process.env, value: options.whitelist });
  if (!whitelistResult.valid) {
    const universe = unavailableMajorUniverse({ whitelistResult, reason: whitelistResult.reason });
    warnMajorUniverse(universe, options.warnFn);
    return universe;
  }
  if (options.dryRun || options.fixture) {
    return buildFixtureBinanceMajorUniverse({ whitelistResult });
  }
  const exchangeInfo = options.exchangeInfo
    || await fetchJson(`${BINANCE_BASE}/api/v3/exchangeInfo?permissions=SPOT`, timeoutMs);
  const universe = buildBinanceMajorUniverse({ exchangeInfo, whitelistResult });
  warnMajorUniverse(universe, options.warnFn);
  return universe;
}

export async function getCachedBinanceTopVolumeUniverse(options = {}) {
  const now = Date.now();
  const ttlMs = Math.max(1_000, Number(options.ttlMs || DEFAULT_CACHE_TTL_MS));
  const env = options.env || process.env;
  const modeResult = resolveCryptoUniverseMode({ env });
  const whitelistKey = modeResult.mode === 'major'
    ? String(options.whitelist ?? env.LUNA_CRYPTO_MAJOR_WHITELIST ?? 'default')
    : 'legacy';
  const cacheKey = `${modeResult.valid}:${modeResult.mode}:${whitelistKey}`;
  if (!options.refresh && cachedUniverse && cachedUniverse.cacheKey === cacheKey && (now - cachedUniverse.cachedAtMs) < ttlMs) {
    return cachedUniverse.value;
  }
  const value = await fetchBinanceTopVolumeUniverse(options);
  cachedUniverse = { cachedAtMs: now, cacheKey, value };
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
  const universeMode = universe?.mode === 'major'
    || universe?.source === BINANCE_MAJOR_UNIVERSE_SOURCE
    ? 'major'
    : universe?.source === BINANCE_TOP_VOLUME_SOURCE
      ? 'top_volume'
      : resolveCryptoUniverseMode().mode;
  const blockReason = resolveBinanceUniverseBlockReason(universe);
  const passReason = universeMode === 'major'
    ? 'in_binance_major_universe'
    : 'in_binance_top30_volume_universe';
  const rank = universe?.ranks?.[canonical] || null;
  const ok = Number(rank || 0) >= 1 && Number(rank || 0) <= Number(universe?.limit || DEFAULT_BINANCE_TOP_VOLUME_LIMIT);
  return {
    ok,
    blocked: !ok,
    reason: ok ? passReason : blockReason,
    code: ok ? passReason : blockReason,
    symbol: canonical,
    canonicalSymbol: canonical,
    rank,
    limit: universe?.limit || DEFAULT_BINANCE_TOP_VOLUME_LIMIT,
    source: universe?.source || BINANCE_TOP_VOLUME_SOURCE,
    fetchedAt: universe?.fetchedAt || null,
    ...(universeMode === 'major' ? { mode: universeMode, failClosed: universe?.failClosed === true } : {}),
  };
}

export function resolveBinanceUniverseBlockReason(universe = null, env = process.env) {
  const universeMode = universe?.mode === 'major'
    || universe?.source === BINANCE_MAJOR_UNIVERSE_SOURCE
    ? 'major'
    : universe?.source === BINANCE_TOP_VOLUME_SOURCE
      ? 'top_volume'
      : resolveCryptoUniverseMode({ env }).mode;
  return universeMode === 'major'
    ? BINANCE_MAJOR_UNIVERSE_BLOCK_REASON
    : BINANCE_TOP_VOLUME_LEGACY_BLOCK_REASON;
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
  BINANCE_MAJOR_UNIVERSE_BLOCK_REASON,
  BINANCE_MAJOR_UNIVERSE_SOURCE,
  BINANCE_MAJOR_WHITELIST_SOURCE,
  BINANCE_TOP_VOLUME_LEGACY_BLOCK_REASON,
  DEFAULT_BINANCE_MAJOR_WHITELIST,
  DEFAULT_BINANCE_MAJOR_UNIVERSE_LIMIT,
  DEFAULT_BINANCE_TOP_VOLUME_LIMIT,
  fetchBinanceTopVolumeUniverse,
  resolveBinanceUniverseBlockReason,
  getCachedBinanceTopVolumeUniverse,
  buildBinanceTopVolumeUniverse,
  buildBinanceMajorUniverse,
  buildFixtureBinanceMajorUniverse,
  buildFixtureBinanceTopVolumeUniverse,
  evaluateBinanceTopVolumeUniverseGate,
  filterSymbolsByBinanceTopVolumeUniverse,
  normalizeBinanceUsdtSymbol,
  parseBinanceMajorWhitelist,
  resolveCryptoUniverseMode,
};
