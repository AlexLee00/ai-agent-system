CREATE TABLE IF NOT EXISTS investment.capital_high_water_mark (
  id BIGSERIAL PRIMARY KEY,
  market TEXT NOT NULL,
  exchange TEXT NOT NULL,
  high_water_mark DOUBLE PRECISION NOT NULL,
  total_capital DOUBLE PRECISION NOT NULL,
  source TEXT NOT NULL DEFAULT 'capital_manager',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_luna_capital_hwm_scope
  ON investment.capital_high_water_mark (market, exchange, observed_at DESC);
