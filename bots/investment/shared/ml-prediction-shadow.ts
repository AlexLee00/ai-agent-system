// @ts-nocheck

import crypto from 'node:crypto';
import * as db from './db.ts';

const TABLE_NAME = 'investment.luna_ml_prediction_shadow';
const TIMEFRAME_MS = Object.freeze({
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 2 * 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
});

function iso(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function deterministicForecastId(parts) {
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

export function buildMlPredictionShadowRecord({
  forecastId = null,
  symbol,
  market = 'crypto',
  source = 'runtime-luna-predictive-evidence-refresh',
  forecast = {},
} = {}) {
  const prediction = forecast.persistencePrediction || forecast.prediction || {};
  const timeframe = String(forecast.timeframe || '').trim().toLowerCase();
  const stepMs = TIMEFRAME_MS[timeframe];
  const horizon = Math.max(1, Math.round(finite(forecast.horizon, 1)));
  const originCandleTs = iso(forecast.originCandleTs);
  const originPrice = finite(prediction.currentPrice);
  const predictedPrice = finite(prediction.predictedPrice);
  const exchange = String(forecast.exchange || '').trim().toLowerCase();
  const modelVersion = String(prediction.modelVersion || 'ml-price-predictor-v1');
  const configVersion = String(prediction.configVersion || 'holt-a0.25-b0.08-blend40-60');
  if (!symbol || !exchange || !originCandleTs || !stepMs || !(originPrice > 0) || !(predictedPrice > 0)) return null;
  if (forecast.dataHealth !== 'ok' || forecast.shadowMode !== true || forecast.originCandleClosed !== true) return null;

  const targetCandleTs = new Date(new Date(originCandleTs).getTime() + stepMs * horizon).toISOString();
  const expectedReturn = finite(prediction.expectedReturn, (predictedPrice - originPrice) / originPrice);
  const direction = ['up', 'down', 'neutral'].includes(prediction.direction)
    ? prediction.direction
    : expectedReturn > 0.01 ? 'up' : expectedReturn < -0.01 ? 'down' : 'neutral';
  const identity = [exchange, symbol, originCandleTs, timeframe, horizon, modelVersion, configVersion];

  return {
    forecastId: String(forecastId || deterministicForecastId(identity)),
    symbol: String(symbol).toUpperCase(),
    exchange,
    market: String(market || 'crypto').toLowerCase(),
    source: String(source || 'runtime-luna-predictive-evidence-refresh'),
    originCandleTs,
    targetCandleTs,
    timeframe,
    horizon,
    originPrice,
    predictedPrice,
    expectedReturn,
    direction,
    confidence: Math.max(0, Math.min(1, finite(prediction.confidence, 0))),
    modelVersion,
    configVersion,
    originCandleClosed: true,
    shadowOnly: true,
    metadata: {
      agent: forecast.agent || 'kairos',
      observedCandles: finite(forecast.observedCandles, 0),
      selectedForecastReason: forecast.selectedForecastReason || null,
    },
  };
}

async function hasTable(queryFn) {
  const rows = await queryFn(
    `SELECT to_regclass($1) AS table_name`,
    [TABLE_NAME],
  );
  return Boolean(rows?.[0]?.table_name);
}

export async function persistMlPredictionShadow(record, { queryFn = db.query } = {}) {
  if (!record || record.shadowOnly !== true || record.originCandleClosed !== true) {
    return { ok: false, status: 'invalid_shadow_forecast' };
  }
  if (!await hasTable(queryFn)) return { ok: true, status: 'schema_missing' };

  const rows = await queryFn(`
    INSERT INTO ${TABLE_NAME} (
      forecast_id, symbol, exchange, market, source,
      origin_candle_ts, target_candle_ts, timeframe, horizon,
      origin_price, predicted_price, expected_return, direction, confidence,
      model_version, config_version, origin_candle_closed, shadow_only, metadata
    ) VALUES (
      $1, $2, $3, $4, $5,
      $6, $7, $8, $9,
      $10, $11, $12, $13, $14,
      $15, $16, TRUE, TRUE, $17::jsonb
    )
    ON CONFLICT (forecast_id) DO NOTHING
    RETURNING forecast_id
  `, [
    record.forecastId,
    record.symbol,
    record.exchange,
    record.market,
    record.source,
    record.originCandleTs,
    record.targetCandleTs,
    record.timeframe,
    record.horizon,
    record.originPrice,
    record.predictedPrice,
    record.expectedReturn,
    record.direction,
    record.confidence,
    record.modelVersion,
    record.configVersion,
    JSON.stringify(record.metadata || {}),
  ]);
  return {
    ok: true,
    status: rows?.length ? 'inserted' : 'duplicate',
    forecastId: record.forecastId,
  };
}

export async function matureMlPredictionShadow({ limit = 200 } = {}, { queryFn = db.query } = {}) {
  if (!await hasTable(queryFn)) return { ok: true, status: 'schema_missing', matured: 0 };
  const cappedLimit = Math.max(1, Math.min(2000, Math.round(finite(limit, 200))));
  const rows = await queryFn(`
    WITH pending AS (
      SELECT *
      FROM ${TABLE_NAME}
      WHERE maturity_status = 'pending'
        AND origin_candle_closed IS TRUE
        AND shadow_only IS TRUE
      ORDER BY origin_candle_ts ASC
      LIMIT $1
    ), realized AS (
      SELECT p.forecast_id, p.origin_price, p.predicted_price, p.direction,
             candle.candle_ts, candle.close,
             (candle.close - p.origin_price) / NULLIF(p.origin_price, 0) AS realized_return
      FROM pending p
      JOIN LATERAL (
        SELECT o.candle_ts, o.close
        FROM ohlcv_cache o
        WHERE o.exchange = p.exchange
          AND o.symbol = p.symbol
          AND o.timeframe = p.timeframe
          AND o.candle_ts > (EXTRACT(EPOCH FROM p.origin_candle_ts) * 1000)::bigint
          AND to_timestamp((o.candle_ts + CASE p.timeframe
            WHEN '1m' THEN 60000 WHEN '3m' THEN 180000 WHEN '5m' THEN 300000
            WHEN '15m' THEN 900000 WHEN '30m' THEN 1800000 WHEN '1h' THEN 3600000
            WHEN '2h' THEN 7200000 WHEN '4h' THEN 14400000 WHEN '1d' THEN 86400000
            ELSE 0 END) / 1000.0) <= NOW()
        ORDER BY o.candle_ts ASC
        OFFSET GREATEST(p.horizon - 1, 0)
        LIMIT 1
      ) candle ON TRUE
    ), updated AS (
      UPDATE ${TABLE_NAME} target
      SET realized_candle_ts = to_timestamp(realized.candle_ts / 1000.0),
          realized_price = realized.close,
          realized_return = realized.realized_return,
          realized_direction = CASE
            WHEN realized.realized_return > 0.01 THEN 'up'
            WHEN realized.realized_return < -0.01 THEN 'down'
            ELSE 'neutral'
          END,
          direction_hit = target.direction = CASE
            WHEN realized.realized_return > 0.01 THEN 'up'
            WHEN realized.realized_return < -0.01 THEN 'down'
            ELSE 'neutral'
          END,
          prediction_error_pct = ABS(realized.close - realized.predicted_price) / NULLIF(realized.origin_price, 0),
          maturity_status = 'matured',
          matured_at = NOW()
      FROM realized
      WHERE target.forecast_id = realized.forecast_id
        AND target.maturity_status = 'pending'
      RETURNING target.forecast_id
    )
    SELECT COUNT(*)::int AS matured_count FROM updated
  `, [cappedLimit]);
  return { ok: true, status: 'matured', matured: Number(rows?.[0]?.matured_count || 0) };
}

export const _testOnly = { deterministicForecastId, TIMEFRAME_MS };
