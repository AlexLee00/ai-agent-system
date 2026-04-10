// @ts-nocheck
import ccxt from 'ccxt';
import { createRequire } from 'module';
import { isDirectExecution, runCliMain } from './cli-runtime.ts';

const require = createRequire(import.meta.url);
const pgPool = require('../../../packages/core/lib/pg-pool');

const SCHEMA = 'investment';
const DEFAULT_EXCHANGE = 'binance';
const MAX_BATCH = 1000;

const TIMEFRAME_MS = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

let _exchange = null;

function getExchange() {
  if (_exchange) return _exchange;
  _exchange = new ccxt.binance({ options: { defaultType: 'spot' } });
  return _exchange;
}

function parseDateMs(value, fallback = null) {
  if (!value) return fallback;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw new Error(`날짜 파싱 실패: ${value}`);
  return ms;
}

function getTimeframeMs(timeframe) {
  const value = TIMEFRAME_MS[timeframe];
  if (!value) throw new Error(`지원하지 않는 timeframe: ${timeframe}`);
  return value;
}

export async function ensureOHLCVCacheTable() {
  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS ohlcv_cache (
      exchange    VARCHAR(32) NOT NULL DEFAULT 'binance',
      symbol      VARCHAR(32) NOT NULL,
      timeframe   VARCHAR(16) NOT NULL,
      candle_ts   BIGINT NOT NULL,
      open        DOUBLE PRECISION NOT NULL,
      high        DOUBLE PRECISION NOT NULL,
      low         DOUBLE PRECISION NOT NULL,
      close       DOUBLE PRECISION NOT NULL,
      volume      DOUBLE PRECISION NOT NULL DEFAULT 0,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (exchange, symbol, timeframe, candle_ts)
    )
  `, []);
  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_ohlcv_cache_symbol_tf_ts
      ON ohlcv_cache(symbol, timeframe, candle_ts DESC)
  `, []);
}

async function upsertOHLCVRows(symbol, timeframe, rows, exchange = DEFAULT_EXCHANGE) {
  for (const row of rows) {
    await pgPool.run(SCHEMA, `
      INSERT INTO ohlcv_cache (exchange, symbol, timeframe, candle_ts, open, high, low, close, volume, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
      ON CONFLICT (exchange, symbol, timeframe, candle_ts)
      DO UPDATE SET
        open = EXCLUDED.open,
        high = EXCLUDED.high,
        low = EXCLUDED.low,
        close = EXCLUDED.close,
        volume = EXCLUDED.volume,
        updated_at = now()
    `, [
      exchange,
      symbol,
      timeframe,
      row[0],
      row[1],
      row[2],
      row[3],
      row[4],
      row[5] || 0,
    ]);
  }
}

async function loadCachedRows(symbol, timeframe, fromMs, toMs, exchange = DEFAULT_EXCHANGE) {
  const rows = await pgPool.query(SCHEMA, `
    SELECT candle_ts, open, high, low, close, volume
    FROM ohlcv_cache
    WHERE exchange = $1
      AND symbol = $2
      AND timeframe = $3
      AND candle_ts >= $4
      AND candle_ts <= $5
    ORDER BY candle_ts ASC
  `, [exchange, symbol, timeframe, fromMs, toMs]);

  return rows.map((row) => [
    Number(row.candle_ts),
    Number(row.open),
    Number(row.high),
    Number(row.low),
    Number(row.close),
    Number(row.volume || 0),
  ]);
}

export async function fetchAndCacheOHLCV(symbol, timeframe, from, to = null, exchange = DEFAULT_EXCHANGE) {
  await ensureOHLCVCacheTable();
  const ex = getExchange();
  const stepMs = getTimeframeMs(timeframe);
  const fromMs = parseDateMs(from);
  const toMs = parseDateMs(to, Date.now());

  let cursor = fromMs;
  while (cursor <= toMs) {
    const rows = await ex.fetchOHLCV(symbol, timeframe, cursor, MAX_BATCH);
    if (!Array.isArray(rows) || rows.length === 0) break;
    const filtered = rows.filter((row) => row[0] <= toMs);
    if (filtered.length > 0) {
      await upsertOHLCVRows(symbol, timeframe, filtered, exchange);
    }
    const lastTs = rows[rows.length - 1]?.[0];
    if (!lastTs || lastTs <= cursor) break;
    cursor = lastTs + stepMs;
    if (rows.length < MAX_BATCH) break;
  }

  return loadCachedRows(symbol, timeframe, fromMs, toMs, exchange);
}

export async function getOHLCV(symbol, timeframe, from, to = null, exchange = DEFAULT_EXCHANGE) {
  await ensureOHLCVCacheTable();
  const fromMs = parseDateMs(from);
  const toMs = parseDateMs(to, Date.now());
  const stepMs = getTimeframeMs(timeframe);
  const cached = await loadCachedRows(symbol, timeframe, fromMs, toMs, exchange);
  const expected = Math.max(1, Math.floor((toMs - fromMs) / stepMs) + 1);

  if (cached.length >= Math.max(1, Math.floor(expected * 0.9))) {
    return cached;
  }

  return fetchAndCacheOHLCV(symbol, timeframe, from, to, exchange);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const args = process.argv.slice(2);
      const symbol = args.find((arg) => arg.startsWith('--symbol='))?.split('=')[1] || 'BTC/USDT';
      const timeframe = args.find((arg) => arg.startsWith('--timeframe='))?.split('=')[1] || '1h';
      const from = args.find((arg) => arg.startsWith('--from='))?.split('=')[1];
      const to = args.find((arg) => arg.startsWith('--to='))?.split('=')[1] || null;
      if (!from) {
        throw new Error('사용법: node shared/ohlcv-fetcher.ts --symbol=BTC/USDT --from=2026-03-01 --timeframe=1h [--to=2026-03-30]');
      }
      return {
        symbol,
        timeframe,
        from,
        to,
        rows: await getOHLCV(symbol, timeframe, from, to),
      };
    },
    onSuccess: async (result) => {
      console.log(JSON.stringify({
        symbol: result.symbol,
        timeframe: result.timeframe,
        from: result.from,
        to: result.to,
        count: result.rows.length,
        first: result.rows[0] || null,
        last: result.rows[result.rows.length - 1] || null,
      }, null, 2));
    },
  });
}
