-- Luna Phase 3 Codex P1: posttrade staged mutation + live/backtest spec consistency.
-- Shadow/staged only. No trade/candidate/order source table mutation.

CREATE TABLE IF NOT EXISTS investment.luna_posttrade_mutation_shadow (
  id                       BIGSERIAL PRIMARY KEY,
  symbol                   TEXT NOT NULL,
  market                   TEXT NOT NULL,
  exchange                 TEXT NOT NULL,
  strategy_family          TEXT,
  mutation_type            TEXT NOT NULL,
  proposed_value           JSONB DEFAULT '{}'::jsonb,
  loss_count               INTEGER DEFAULT 0,
  closed_count             INTEGER DEFAULT 0,
  avg_pnl_pct              DOUBLE PRECISION DEFAULT 0,
  worst_pnl_pct            DOUBLE PRECISION DEFAULT 0,
  last_loss_at             TIMESTAMPTZ,
  severity                 DOUBLE PRECISION DEFAULT 0,
  confidence               DOUBLE PRECISION DEFAULT 0,
  status                   TEXT NOT NULL DEFAULT 'staged',
  requires_master_confirm  BOOLEAN DEFAULT TRUE,
  confirm_token            TEXT,
  shadow_only              BOOLEAN DEFAULT TRUE,
  source_trade_ids         JSONB DEFAULT '[]'::jsonb,
  evidence                 JSONB DEFAULT '{}'::jsonb,
  observed_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_luna_posttrade_mutation_shadow_symbol
  ON investment.luna_posttrade_mutation_shadow(symbol, market, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_luna_posttrade_mutation_shadow_type
  ON investment.luna_posttrade_mutation_shadow(mutation_type, status, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_luna_posttrade_mutation_shadow_evidence
  ON investment.luna_posttrade_mutation_shadow USING GIN (evidence);

CREATE TABLE IF NOT EXISTS investment.luna_deployment_spec_shadow (
  id                         BIGSERIAL PRIMARY KEY,
  spec_hash                  TEXT NOT NULL,
  spec_version               TEXT NOT NULL,
  mode                       TEXT NOT NULL DEFAULT 'paper',
  symbol                     TEXT,
  market                     TEXT,
  exchange                   TEXT,
  decision_spec              JSONB DEFAULT '{}'::jsonb,
  live_backtest_consistent   BOOLEAN DEFAULT FALSE,
  inconsistency_reasons      JSONB DEFAULT '[]'::jsonb,
  shadow_only                BOOLEAN DEFAULT TRUE,
  observed_at                TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_luna_deployment_spec_shadow_hash
  ON investment.luna_deployment_spec_shadow(spec_hash, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_luna_deployment_spec_shadow_symbol
  ON investment.luna_deployment_spec_shadow(symbol, market, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_luna_deployment_spec_shadow_consistency
  ON investment.luna_deployment_spec_shadow(live_backtest_consistent, observed_at DESC);
