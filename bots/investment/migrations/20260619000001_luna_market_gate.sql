-- Luna P1-2: C1 market deployment gate history
-- Shadow-only logging table. Runtime decision paths do not consume this table.

CREATE SCHEMA IF NOT EXISTS investment;

CREATE TABLE IF NOT EXISTS investment.luna_market_gate_history (
  id          BIGSERIAL PRIMARY KEY,
  market      TEXT NOT NULL CHECK (market IN ('overseas', 'domestic', 'crypto')),
  score       NUMERIC,
  deployment  TEXT NOT NULL CHECK (deployment IN ('full', 'reduced', 'halt', 'unknown')),
  signals     JSONB NOT NULL DEFAULT '{}'::jsonb,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE investment.luna_market_gate_history
  ADD COLUMN IF NOT EXISTS market TEXT,
  ADD COLUMN IF NOT EXISTS score NUMERIC,
  ADD COLUMN IF NOT EXISTS deployment TEXT,
  ADD COLUMN IF NOT EXISTS signals JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS computed_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_luna_market_gate_history_market_time
  ON investment.luna_market_gate_history (market, computed_at DESC);

COMMENT ON TABLE investment.luna_market_gate_history IS
  'Luna P1-2 shadow-only C1 market deployment gate score history.';
