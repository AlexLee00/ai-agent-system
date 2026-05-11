CREATE TABLE IF NOT EXISTS investment.luna_rl_policy_shadow (
  id                BIGSERIAL PRIMARY KEY,
  symbol            TEXT NOT NULL,
  exchange          TEXT NOT NULL DEFAULT 'binance',
  market            TEXT NOT NULL DEFAULT 'crypto',
  state_vector      JSONB DEFAULT '{}'::jsonb,
  action            NUMERIC(10,6) DEFAULT 0,
  action_type       TEXT DEFAULT 'hold',
  action_size_pct   NUMERIC(8,6) DEFAULT 0,
  confidence        NUMERIC(8,6) DEFAULT 0,
  reward_estimate   NUMERIC(12,6) DEFAULT 0,
  model_status      TEXT DEFAULT 'unknown',
  data_health       TEXT DEFAULT 'unknown',
  context_evidence  JSONB DEFAULT '{}'::jsonb,
  shadow_only       BOOLEAN NOT NULL DEFAULT true,
  observed_at       TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_luna_rl_policy_shadow_symbol_observed
  ON investment.luna_rl_policy_shadow(exchange, symbol, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_rl_policy_shadow_market_action
  ON investment.luna_rl_policy_shadow(market, action_type, confidence DESC, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_rl_policy_shadow_state_vector
  ON investment.luna_rl_policy_shadow USING GIN (state_vector);
