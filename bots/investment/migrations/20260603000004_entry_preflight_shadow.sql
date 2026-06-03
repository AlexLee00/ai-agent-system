-- S2 C3: entry-trigger materialize preflight SHADOW comparison.
-- SHADOW only: actual materialize/order execution must remain unchanged.

CREATE TABLE IF NOT EXISTS investment.entry_preflight_shadow (
  id                     BIGSERIAL PRIMARY KEY,
  trigger_id             TEXT,
  candidate_id           TEXT,
  symbol                 TEXT NOT NULL,
  exchange               TEXT NOT NULL DEFAULT 'binance',
  trade_mode             TEXT NOT NULL DEFAULT 'normal',
  preflight_decision     TEXT NOT NULL,
  preflight_reason       TEXT,
  preflight_checks       JSONB NOT NULL DEFAULT '{}'::jsonb,
  would_defer            BOOLEAN NOT NULL DEFAULT false,
  materialized_signal_id TEXT,
  executor_status        TEXT,
  executor_block_code    TEXT,
  executor_block_reason  TEXT,
  agreement              BOOLEAN,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_entry_preflight_shadow_trigger
  ON investment.entry_preflight_shadow(trigger_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entry_preflight_shadow_signal
  ON investment.entry_preflight_shadow(materialized_signal_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entry_preflight_shadow_decision
  ON investment.entry_preflight_shadow(preflight_decision, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entry_preflight_shadow_symbol
  ON investment.entry_preflight_shadow(exchange, symbol, created_at DESC);

COMMENT ON TABLE investment.entry_preflight_shadow IS
  'SHADOW: predicts entry-trigger materialize preflight defer/skip decisions before executor blocking.';
