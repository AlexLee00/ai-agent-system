-- Draft only. Master applies after review; runtime code never creates this table.
-- Shadow forecast evidence only. No live score, sizing, order, or gate consumes it.

CREATE SCHEMA IF NOT EXISTS investment;

CREATE TABLE IF NOT EXISTS investment.luna_ml_prediction_shadow (
  forecast_id            TEXT PRIMARY KEY,
  symbol                 TEXT NOT NULL,
  exchange               TEXT NOT NULL,
  market                 TEXT NOT NULL DEFAULT 'crypto',
  source                 TEXT NOT NULL,
  origin_candle_ts       TIMESTAMPTZ NOT NULL,
  target_candle_ts       TIMESTAMPTZ NOT NULL,
  timeframe              TEXT NOT NULL,
  horizon                INTEGER NOT NULL CHECK (horizon > 0),
  origin_price           NUMERIC NOT NULL CHECK (origin_price > 0),
  predicted_price        NUMERIC NOT NULL CHECK (predicted_price > 0),
  expected_return        DOUBLE PRECISION NOT NULL,
  direction              TEXT NOT NULL CHECK (direction IN ('up', 'down', 'neutral')),
  confidence             DOUBLE PRECISION NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  model_version          TEXT NOT NULL,
  config_version         TEXT NOT NULL,
  origin_candle_closed   BOOLEAN NOT NULL DEFAULT TRUE CHECK (origin_candle_closed IS TRUE),
  shadow_only            BOOLEAN NOT NULL DEFAULT TRUE CHECK (shadow_only IS TRUE),
  maturity_status        TEXT NOT NULL DEFAULT 'pending' CHECK (maturity_status IN ('pending', 'matured')),
  realized_candle_ts     TIMESTAMPTZ,
  realized_price         NUMERIC,
  realized_return        DOUBLE PRECISION,
  realized_direction     TEXT CHECK (realized_direction IN ('up', 'down', 'neutral')),
  direction_hit          BOOLEAN,
  prediction_error_pct   DOUBLE PRECISION,
  matured_at             TIMESTAMPTZ,
  metadata               JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (exchange, symbol, origin_candle_ts, timeframe, horizon, model_version, config_version)
);

CREATE INDEX IF NOT EXISTS idx_luna_ml_prediction_shadow_maturity
  ON investment.luna_ml_prediction_shadow(maturity_status, target_candle_ts);

CREATE INDEX IF NOT EXISTS idx_luna_ml_prediction_shadow_symbol_origin
  ON investment.luna_ml_prediction_shadow(exchange, symbol, origin_candle_ts DESC);

COMMENT ON TABLE investment.luna_ml_prediction_shadow IS
  'Closed-origin ML forecast and maturity evidence. Shadow only; never consumed by live trading decisions.';

GRANT USAGE ON SCHEMA investment TO hub_readonly;
GRANT SELECT ON TABLE investment.luna_ml_prediction_shadow TO hub_readonly;
