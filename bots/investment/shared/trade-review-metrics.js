import ccxt from 'ccxt';
import https from 'https';

let _publicExchange = null;

function getPublicExchange() {
  if (_publicExchange) return _publicExchange;
  _publicExchange = new ccxt.binance({
    options: { defaultType: 'spot' },
  });
  return _publicExchange;
}

async function fetchBinanceWindow(symbol, timeframe, sinceMs, limit = 1000, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await getPublicExchange().fetchOHLCV(symbol, timeframe, sinceMs, limit);
    } catch (err) {
      if (attempt >= retries) throw err;
      await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
    }
  }
  return [];
}

function fetchYahooWindow(ticker, interval, startMs, endMs) {
  return new Promise((resolve, reject) => {
    const period1 = Math.max(0, Math.floor(startMs / 1000) - 3600);
    const period2 = Math.floor(endMs / 1000) + 3600;
    const urlPath = `/v8/finance/chart/${ticker}?period1=${period1}&period2=${period2}&interval=${interval}&includePrePost=false&events=div,splits`;

    const req = https.request(
      {
        hostname: 'query1.finance.yahoo.com',
        path: urlPath,
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      },
      res => {
        let raw = '';
        res.on('data', chunk => {
          raw += chunk;
        });
        res.on('end', () => {
          try {
            const json = JSON.parse(raw);
            const chart = json.chart?.result?.[0];
            if (!chart) {
              resolve([]);
              return;
            }
            const timestamps = chart.timestamp || [];
            const quote = chart.indicators?.quote?.[0] || {};
            const rows = timestamps.map((ts, idx) => ([
              ts * 1000,
              Number(quote.open?.[idx] || 0),
              Number(quote.high?.[idx] || 0),
              Number(quote.low?.[idx] || 0),
              Number(quote.close?.[idx] || 0),
              Number(quote.volume?.[idx] || 0),
            ])).filter(row => row[4] > 0);
            resolve(rows);
          } catch (err) {
            reject(new Error(`Yahoo Finance 파싱 실패: ${err.message}`));
          }
        });
      },
    );

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Yahoo Finance 타임아웃'));
    });
    req.end();
  });
}

function toYahooTicker(symbol, exchange) {
  if (exchange === 'kis' && /^\d{6}$/.test(symbol)) return `${symbol}.KS`;
  return symbol;
}

function chooseIntervals(exchange, holdMs) {
  if (exchange === 'binance') {
    if (holdMs <= 3 * 24 * 60 * 60 * 1000) return { provider: 'binance', interval: '15m' };
    if (holdMs <= 45 * 24 * 60 * 60 * 1000) return { provider: 'binance', interval: '1h' };
    return { provider: 'binance', interval: '4h' };
  }

  if (holdMs <= 60 * 24 * 60 * 60 * 1000) return { provider: 'yahoo', interval: '60m' };
  return { provider: 'yahoo', interval: '1d' };
}

function computeLongExcursions(entryPrice, exitPrice, candles = []) {
  const safeEntry = Number(entryPrice || 0);
  if (safeEntry <= 0) {
    return { maxFavorable: null, maxAdverse: null, source: 'invalid_entry' };
  }

  let maxHigh = Math.max(safeEntry, Number(exitPrice || 0) || safeEntry);
  let minLow = Math.min(safeEntry, Number(exitPrice || 0) || safeEntry);

  for (const candle of candles) {
    const high = Number(candle?.[2] || 0);
    const low = Number(candle?.[3] || 0);
    if (high > 0) maxHigh = Math.max(maxHigh, high);
    if (low > 0) minLow = Math.min(minLow, low);
  }

  return {
    maxFavorable: Number((((maxHigh - safeEntry) / safeEntry) * 100).toFixed(4)),
    maxAdverse: Number((((minLow - safeEntry) / safeEntry) * 100).toFixed(4)),
    source: candles.length > 0 ? 'market_data' : 'entry_exit_only',
  };
}

export async function computeTradeExcursions({
  symbol,
  exchange,
  entryTime,
  exitTime,
  entryPrice,
  exitPrice,
  direction = 'long',
}) {
  const startMs = Number(entryTime || 0);
  const endMs = Number(exitTime || 0);
  const holdMs = Math.max(0, endMs - startMs);

  if (!symbol || !exchange || startMs <= 0 || endMs <= 0 || holdMs <= 0) {
    return { maxFavorable: null, maxAdverse: null, source: 'insufficient_window' };
  }

  if (direction !== 'long') {
    return { maxFavorable: null, maxAdverse: null, source: 'unsupported_direction' };
  }

  const mode = chooseIntervals(exchange, holdMs);

  try {
    let candles = [];
    if (mode.provider === 'binance') {
      candles = await fetchBinanceWindow(symbol, mode.interval, startMs);
      candles = candles.filter(candle => candle[0] >= startMs && candle[0] <= endMs + 60_000);
    } else {
      const ticker = toYahooTicker(symbol, exchange);
      candles = await fetchYahooWindow(ticker, mode.interval, startMs, endMs);
      candles = candles.filter(candle => candle[0] >= startMs - 60_000 && candle[0] <= endMs + 60_000);
    }

    return {
      ...computeLongExcursions(entryPrice, exitPrice, candles),
      interval: mode.interval,
      candleCount: candles.length,
    };
  } catch (err) {
    return {
      ...computeLongExcursions(entryPrice, exitPrice, []),
      interval: mode.interval,
      candleCount: 0,
      source: 'fallback_entry_exit_only',
      error: err.message,
    };
  }
}

export default {
  computeTradeExcursions,
};
