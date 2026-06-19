-- Luna ET-D: C3 strategy-family exit shadow comparison.
-- Shadow/advisory only. This table is not consumed by live closeout or order execution.

CREATE SCHEMA IF NOT EXISTS investment;

CREATE TABLE IF NOT EXISTS investment.luna_strategy_exit_shadow (
  id                BIGSERIAL PRIMARY KEY,
  position_id       TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  exchange          TEXT NOT NULL,
  family            TEXT NOT NULL,
  c3_decision       TEXT NOT NULL CHECK (c3_decision IN ('exit', 'hold')),
  c3_reason         TEXT,
  current_decision  TEXT NOT NULL,
  current_reason    TEXT,
  agreement         BOOLEAN NOT NULL,
  candle_ts         TIMESTAMPTZ NOT NULL,
  c3_exit_price     NUMERIC,
  last_price        NUMERIC,
  evaluated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  shadow_only       BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (position_id, candle_ts)
);

CREATE INDEX IF NOT EXISTS idx_luna_strategy_exit_shadow_symbol_eval
  ON investment.luna_strategy_exit_shadow(exchange, symbol, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_strategy_exit_shadow_family_agreement
  ON investment.luna_strategy_exit_shadow(family, agreement, evaluated_at DESC);

COMMENT ON TABLE investment.luna_strategy_exit_shadow IS
  'Luna ET-D shadow comparison between C3 strategy-family exit rules and current position reevaluator decisions. Not used for live closeout or orders.';
