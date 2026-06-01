-- Luna signal robust learning SHADOW policy scores.
-- Production grid/search/promotion behavior is unchanged; this table stores
-- policy-candidate evaluation evidence only.

CREATE TABLE IF NOT EXISTS investment.luna_signal_policy_shadow (
  id                     BIGSERIAL PRIMARY KEY,
  policy_name            TEXT NOT NULL,
  policy_config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  market                 TEXT NOT NULL,
  sample_count           INTEGER NOT NULL DEFAULT 0,
  skipped_count          INTEGER NOT NULL DEFAULT 0,
  oos_positive_rate      DOUBLE PRECISION,
  oos_sharpe             DOUBLE PRECISION,
  overfit_gap            DOUBLE PRECISION,
  wf_pass_rate           DOUBLE PRECISION,
  verified_healthy_count INTEGER NOT NULL DEFAULT 0,
  baseline_score         DOUBLE PRECISION,
  raw_score              DOUBLE PRECISION,
  score                  DOUBLE PRECISION NOT NULL DEFAULT 0,
  score_delta            DOUBLE PRECISION,
  component_scores       JSONB NOT NULL DEFAULT '{}'::jsonb,
  data_health            TEXT NOT NULL DEFAULT 'unknown',
  shadow_only            BOOLEAN NOT NULL DEFAULT true,
  observed_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_luna_signal_policy_shadow_market_score
  ON investment.luna_signal_policy_shadow (market, score DESC, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_signal_policy_shadow_policy_observed
  ON investment.luna_signal_policy_shadow (policy_name, market, observed_at DESC);

COMMENT ON TABLE investment.luna_signal_policy_shadow IS
  'SHADOW: robust signal selection policy evaluation and learning scores';
