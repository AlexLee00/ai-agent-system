-- Luna Phase 4 Codex P2: live-forward validation + strategy enhancement shadow.
-- Shadow/staged only. No live order, candidate, strategy, or protected process mutation.

CREATE TABLE IF NOT EXISTS investment.luna_phase4_live_forward_shadow (
  id                         BIGSERIAL PRIMARY KEY,
  symbol                     TEXT NOT NULL,
  market                     TEXT NOT NULL,
  exchange                   TEXT NOT NULL,
  strategy_family            TEXT,
  validation_model           TEXT NOT NULL DEFAULT 'ama_finsaber_shadow_v1',
  live_forward_status        TEXT NOT NULL DEFAULT 'shadow_hold',
  recommendation             TEXT NOT NULL DEFAULT 'keep_shadow',
  ama_score                  DOUBLE PRECISION DEFAULT 0,
  finsaber_score             DOUBLE PRECISION DEFAULT 0,
  regime_risk_score          DOUBLE PRECISION DEFAULT 0,
  backtest_fresh             BOOLEAN DEFAULT FALSE,
  predictive_coverage        DOUBLE PRECISION DEFAULT 0,
  community_source_count     INTEGER DEFAULT 0,
  max_drawdown_pct           DOUBLE PRECISION DEFAULT 0,
  hyperopt_required          BOOLEAN DEFAULT FALSE,
  live_mutation              BOOLEAN DEFAULT FALSE,
  shadow_only                BOOLEAN DEFAULT TRUE,
  reasons                    JSONB DEFAULT '[]'::jsonb,
  evidence                   JSONB DEFAULT '{}'::jsonb,
  observed_at                TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_luna_phase4_live_forward_symbol
  ON investment.luna_phase4_live_forward_shadow(symbol, market, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_luna_phase4_live_forward_status
  ON investment.luna_phase4_live_forward_shadow(live_forward_status, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_luna_phase4_live_forward_evidence
  ON investment.luna_phase4_live_forward_shadow USING GIN (evidence);

CREATE TABLE IF NOT EXISTS investment.luna_phase4_strategy_enhancement_shadow (
  id                         BIGSERIAL PRIMARY KEY,
  symbol                     TEXT NOT NULL,
  market                     TEXT NOT NULL,
  exchange                   TEXT NOT NULL,
  enhancement_model          TEXT NOT NULL DEFAULT 'hyperopt_risk_indicator_shadow_v1',
  enhancement_status         TEXT NOT NULL DEFAULT 'shadow_review',
  hyperopt_status            TEXT NOT NULL DEFAULT 'planned',
  best_params                JSONB DEFAULT '{}'::jsonb,
  max_drawdown_guard         TEXT NOT NULL DEFAULT 'observe',
  indicator_score            DOUBLE PRECISION DEFAULT 0,
  provider_status            TEXT NOT NULL DEFAULT 'shadow',
  live_mutation              BOOLEAN DEFAULT FALSE,
  shadow_only                BOOLEAN DEFAULT TRUE,
  reasons                    JSONB DEFAULT '[]'::jsonb,
  evidence                   JSONB DEFAULT '{}'::jsonb,
  observed_at                TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_luna_phase4_strategy_symbol
  ON investment.luna_phase4_strategy_enhancement_shadow(symbol, market, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_luna_phase4_strategy_status
  ON investment.luna_phase4_strategy_enhancement_shadow(enhancement_status, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_luna_phase4_strategy_evidence
  ON investment.luna_phase4_strategy_enhancement_shadow USING GIN (evidence);
