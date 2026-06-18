-- Luna C7-1 universe snapshot accumulator.
-- Additive point-in-time storage only; candidate_universe remains the live TTL table.

CREATE SCHEMA IF NOT EXISTS investment;

CREATE TABLE IF NOT EXISTS investment.universe_snapshot (
  id            BIGSERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  symbol        TEXT NOT NULL,
  market        TEXT NOT NULL CHECK (market IN ('domestic', 'overseas', 'crypto')),
  source        TEXT NOT NULL,
  source_tier   INTEGER,
  score         NUMERIC(5,4),
  confidence    DOUBLE PRECISION,
  quality_flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  reason_code   TEXT,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (snapshot_date, symbol, market, source)
);

CREATE INDEX IF NOT EXISTS idx_universe_snapshot_date
  ON investment.universe_snapshot(snapshot_date);

CREATE INDEX IF NOT EXISTS idx_universe_snapshot_symbol_market
  ON investment.universe_snapshot(symbol, market);

COMMENT ON TABLE investment.universe_snapshot IS
  'Append-only daily candidate_universe point-in-time snapshots for C7 survivorship-bias control.';
