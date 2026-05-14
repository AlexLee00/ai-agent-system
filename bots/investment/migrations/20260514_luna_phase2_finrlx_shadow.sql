-- Luna Phase 2 FinRL-X shadow/paper tables.
-- Shadow/Paper only: no source trade table mutation and no live order side effects.

CREATE TABLE IF NOT EXISTS investment.luna_weight_vector_shadow (
  id                  BIGSERIAL PRIMARY KEY,
  symbol              TEXT NOT NULL,
  market              TEXT NOT NULL,
  exchange            TEXT NOT NULL,
  candidate_score     DOUBLE PRECISION DEFAULT 0,
  backtest_score      DOUBLE PRECISION DEFAULT 0,
  predictive_score    DOUBLE PRECISION DEFAULT 0,
  community_score     DOUBLE PRECISION DEFAULT 0,
  target_weight       DOUBLE PRECISION DEFAULT 0,
  confidence          DOUBLE PRECISION DEFAULT 0,
  risk_budget_usdt    DOUBLE PRECISION DEFAULT 0,
  signal              TEXT NOT NULL DEFAULT 'hold',
  gate_status         TEXT NOT NULL DEFAULT 'shadow',
  no_lookahead_ok     BOOLEAN DEFAULT TRUE,
  shadow_only         BOOLEAN DEFAULT TRUE,
  evidence            JSONB DEFAULT '{}'::jsonb,
  observed_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_luna_weight_vector_shadow_symbol
  ON investment.luna_weight_vector_shadow(symbol, market, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_luna_weight_vector_shadow_signal
  ON investment.luna_weight_vector_shadow(signal, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_luna_weight_vector_shadow_observed
  ON investment.luna_weight_vector_shadow(observed_at DESC);

CREATE TABLE IF NOT EXISTS investment.luna_paper_trading_shadow (
  id                   BIGSERIAL PRIMARY KEY,
  symbol               TEXT NOT NULL,
  market               TEXT NOT NULL,
  exchange             TEXT NOT NULL,
  target_weight        DOUBLE PRECISION DEFAULT 0,
  current_weight       DOUBLE PRECISION DEFAULT 0,
  delta_weight         DOUBLE PRECISION DEFAULT 0,
  paper_side           TEXT NOT NULL DEFAULT 'HOLD',
  paper_notional_usdt  DOUBLE PRECISION DEFAULT 0,
  paper_quantity       DOUBLE PRECISION DEFAULT 0,
  reference_price      DOUBLE PRECISION DEFAULT 0,
  confidence           DOUBLE PRECISION DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'planned',
  shadow_only          BOOLEAN DEFAULT TRUE,
  evidence             JSONB DEFAULT '{}'::jsonb,
  observed_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_luna_paper_trading_shadow_symbol
  ON investment.luna_paper_trading_shadow(symbol, market, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_luna_paper_trading_shadow_side
  ON investment.luna_paper_trading_shadow(paper_side, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_luna_paper_trading_shadow_observed
  ON investment.luna_paper_trading_shadow(observed_at DESC);
