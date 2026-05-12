CREATE TABLE IF NOT EXISTS investment.luna_risk_simulation_shadow (
  id                       BIGSERIAL PRIMARY KEY,
  analysis_type            TEXT NOT NULL,
  symbols                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  exchange                 TEXT NOT NULL DEFAULT 'binance',
  market                   TEXT NOT NULL DEFAULT 'crypto',
  scenario                 TEXT DEFAULT 'base',
  simulations              INTEGER DEFAULT 0,
  var_95                   NUMERIC(12,6) DEFAULT 0,
  var_99                   NUMERIC(12,6) DEFAULT 0,
  cvar_95                  NUMERIC(12,6) DEFAULT 0,
  cvar_99                  NUMERIC(12,6) DEFAULT 0,
  max_loss_estimate        NUMERIC(12,6) DEFAULT 0,
  recovery_days_estimate   INTEGER,
  risk_limits              JSONB DEFAULT '{}'::jsonb,
  scenario_metrics         JSONB DEFAULT '{}'::jsonb,
  data_health              TEXT DEFAULT 'unknown',
  context_evidence         JSONB DEFAULT '{}'::jsonb,
  shadow_only              BOOLEAN NOT NULL DEFAULT true,
  observed_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_luna_risk_simulation_shadow_type_observed
  ON investment.luna_risk_simulation_shadow(analysis_type, exchange, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_risk_simulation_shadow_market_scenario
  ON investment.luna_risk_simulation_shadow(market, scenario, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_risk_simulation_shadow_symbols
  ON investment.luna_risk_simulation_shadow USING GIN (symbols);
