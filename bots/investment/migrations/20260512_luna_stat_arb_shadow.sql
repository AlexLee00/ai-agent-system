CREATE TABLE IF NOT EXISTS investment.luna_stat_arb_shadow (
  id                       BIGSERIAL PRIMARY KEY,
  strategy_type            TEXT NOT NULL,
  symbols                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  exchange                 TEXT NOT NULL DEFAULT 'binance',
  market                   TEXT NOT NULL DEFAULT 'crypto',
  pair_metrics             JSONB DEFAULT '{}'::jsonb,
  mean_reversion_metrics   JSONB DEFAULT '{}'::jsonb,
  signal                   TEXT DEFAULT 'neutral',
  z_score                  NUMERIC(12,6) DEFAULT 0,
  confidence               NUMERIC(8,6) DEFAULT 0,
  data_health              TEXT DEFAULT 'unknown',
  context_evidence         JSONB DEFAULT '{}'::jsonb,
  shadow_only              BOOLEAN NOT NULL DEFAULT true,
  observed_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_luna_stat_arb_shadow_strategy_observed
  ON investment.luna_stat_arb_shadow(strategy_type, exchange, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_stat_arb_shadow_market_signal
  ON investment.luna_stat_arb_shadow(market, signal, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_stat_arb_shadow_symbols
  ON investment.luna_stat_arb_shadow USING GIN (symbols);
