-- Luna ET-C: expected-fire watchdog silent miss log.
-- Shadow/advisory only. This table is not consumed by live entry fire or order execution.

CREATE SCHEMA IF NOT EXISTS investment;

CREATE TABLE IF NOT EXISTS investment.luna_silent_miss_log (
  id                BIGSERIAL PRIMARY KEY,
  trigger_id        TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  exchange          TEXT NOT NULL,
  setup_type        TEXT,
  ready_at          TIMESTAMPTZ NOT NULL,
  expired_at        TIMESTAMPTZ,
  predictive_score  DOUBLE PRECISION,
  confidence        DOUBLE PRECISION,
  reason            TEXT,
  matched           BOOLEAN NOT NULL DEFAULT FALSE,
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  shadow_only       BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (trigger_id)
);

CREATE INDEX IF NOT EXISTS idx_luna_silent_miss_log_detected_at
  ON investment.luna_silent_miss_log(detected_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_silent_miss_log_symbol_exchange
  ON investment.luna_silent_miss_log(symbol, exchange);

COMMENT ON TABLE investment.luna_silent_miss_log IS
  'Luna ET-C shadow log for entry triggers that were ready but did not fire or match execution. Retain for 30 days by watchdog pruning.';
