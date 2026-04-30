// @ts-nocheck

export function normalizeMarket(market = 'binance') {
  const key = String(market || 'binance').toLowerCase();
  if (key.includes('domestic')) return 'kis_domestic';
  if (key.includes('overseas')) return 'kis_overseas';
  if (key.includes('tradingview')) return 'tradingview';
  if (key.includes('kis')) return 'kis_domestic';
  return 'binance';
}

export function normalizeSymbol(symbol = 'BTC/USDT') {
  return String(symbol || 'BTC/USDT').trim().toUpperCase();
}

function stableNumber(seed, min, max) {
  const text = String(seed);
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return min + (hash % 10_000) / 10_000 * (max - min);
}

export function getMarketSnapshot({ market = 'binance', symbol = 'BTC/USDT', timeframe = '1h' } = {}) {
  const normalizedMarket = normalizeMarket(market);
  const normalizedSymbol = normalizeSymbol(symbol);
  const price = stableNumber(`${normalizedMarket}:${normalizedSymbol}:price`, 10, 100_000);
  const changePct24h = stableNumber(`${normalizedMarket}:${normalizedSymbol}:change`, -0.08, 0.08);
  const volume24h = stableNumber(`${normalizedMarket}:${normalizedSymbol}:volume`, 100_000, 80_000_000);

  return {
    ok: true,
    source: 'luna-marketdata-mcp',
    market: normalizedMarket,
    symbol: normalizedSymbol,
    timeframe,
    price: Number(price.toFixed(6)),
    changePct24h: Number(changePct24h.toFixed(6)),
    volume24h: Number(volume24h.toFixed(2)),
    stale: false,
    fetchedAt: new Date().toISOString(),
  };
}

export function getMarketRegime({ market = 'binance', symbol = 'BTC/USDT' } = {}) {
  const snapshot = getMarketSnapshot({ market, symbol });
  const trend = snapshot.changePct24h > 0.025 ? 'bull' : snapshot.changePct24h < -0.025 ? 'bear' : 'range';
  const volatility = Math.abs(snapshot.changePct24h) > 0.05 ? 'high' : 'normal';
  return {
    ok: true,
    source: 'luna-marketdata-mcp',
    market: snapshot.market,
    symbol: snapshot.symbol,
    regime: `${volatility}_${trend}`,
    trend,
    volatility,
    confidence: volatility === 'high' ? 0.62 : 0.55,
    computedAt: new Date().toISOString(),
  };
}

export function getOrderBook({ market = 'binance', symbol = 'BTC/USDT', depth = 5 } = {}) {
  const snapshot = getMarketSnapshot({ market, symbol });
  const levels = Math.max(1, Math.min(20, Number(depth) || 5));
  const spread = snapshot.price * 0.0005;
  const bids = [];
  const asks = [];

  for (let i = 0; i < levels; i += 1) {
    const size = Number(stableNumber(`${snapshot.symbol}:size:${i}`, 0.1, 20).toFixed(6));
    bids.push([Number((snapshot.price - spread * (i + 1)).toFixed(6)), size]);
    asks.push([Number((snapshot.price + spread * (i + 1)).toFixed(6)), size]);
  }

  return {
    ok: true,
    source: 'luna-marketdata-mcp',
    market: snapshot.market,
    symbol: snapshot.symbol,
    bids,
    asks,
    fetchedAt: new Date().toISOString(),
  };
}

