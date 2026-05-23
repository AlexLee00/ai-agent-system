CREATE TABLE IF NOT EXISTS investment.korea_public_data_shadow_signals (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy            TEXT NOT NULL,
  stock_code          TEXT,
  company_name        TEXT,
  action              TEXT,
  confidence          NUMERIC,
  signal_score        NUMERIC,
  data_health         TEXT,
  source              TEXT DEFAULT 'luna_korea_public_data_shadow',
  evidence            JSONB DEFAULT '{}'::jsonb,
  result              JSONB DEFAULT '{}'::jsonb,
  shadow_only         BOOLEAN DEFAULT TRUE,
  live_order_allowed  BOOLEAN DEFAULT FALSE,
  observed_at         TIMESTAMPTZ DEFAULT NOW(),
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_korea_public_data_shadow_signals_observed
  ON investment.korea_public_data_shadow_signals(observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_korea_public_data_shadow_signals_strategy_action
  ON investment.korea_public_data_shadow_signals(strategy, action, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_korea_public_data_shadow_signals_stock
  ON investment.korea_public_data_shadow_signals(stock_code, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_korea_public_data_shadow_signals_evidence
  ON investment.korea_public_data_shadow_signals USING GIN (evidence);
