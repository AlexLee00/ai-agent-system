CREATE TABLE IF NOT EXISTS investment.luna_factor_model_shadow (
  id               BIGSERIAL PRIMARY KEY,
  symbol           TEXT NOT NULL,
  exchange         TEXT NOT NULL DEFAULT 'binance',
  market           TEXT NOT NULL DEFAULT 'crypto',
  factor_scores    JSONB DEFAULT '{}'::jsonb,
  composite_score  NUMERIC(8,6) DEFAULT 0,
  rank             INTEGER,
  allocation_hint  JSONB DEFAULT '{}'::jsonb,
  data_health      TEXT DEFAULT 'unknown',
  context_evidence JSONB DEFAULT '{}'::jsonb,
  shadow_only      BOOLEAN NOT NULL DEFAULT true,
  observed_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_luna_factor_model_shadow_symbol_observed
  ON investment.luna_factor_model_shadow(exchange, symbol, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_factor_model_shadow_market_rank
  ON investment.luna_factor_model_shadow(market, exchange, rank, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_factor_model_shadow_scores
  ON investment.luna_factor_model_shadow USING GIN (factor_scores);
