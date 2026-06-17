-- Luna Alpha Factor WS-R shadow/advisory storage.

CREATE SCHEMA IF NOT EXISTS investment;

CREATE TABLE IF NOT EXISTS investment.luna_alpha_factors (
  id BIGSERIAL PRIMARY KEY,
  factor_name TEXT NOT NULL,
  expression TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  market TEXT NOT NULL DEFAULT 'domestic',
  universe TEXT NOT NULL DEFAULT 'domestic_equity',
  status TEXT NOT NULL DEFAULT 'generated'
    CHECK (status IN ('generated', 'evaluated', 'shadow', 'promotion_candidate', 'rejected')),
  complexity INTEGER NOT NULL DEFAULT 0,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  gate JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  universe_asof TIMESTAMPTZ,
  shadow_only BOOLEAN NOT NULL DEFAULT TRUE,
  generated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (factor_name, expression, market)
);

CREATE INDEX IF NOT EXISTS idx_luna_alpha_factors_status_created
  ON investment.luna_alpha_factors (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_alpha_factors_market_status
  ON investment.luna_alpha_factors (market, status);

CREATE TABLE IF NOT EXISTS investment.luna_alpha_factor_evaluations (
  id BIGSERIAL PRIMARY KEY,
  factor_id BIGINT REFERENCES investment.luna_alpha_factors(id) ON DELETE CASCADE,
  factor_name TEXT NOT NULL,
  market TEXT NOT NULL DEFAULT 'domestic',
  horizon_days INTEGER NOT NULL DEFAULT 5,
  ic DOUBLE PRECISION,
  rank_ic DOUBLE PRECISION,
  rank_ir DOUBLE PRECISION,
  permutation_p DOUBLE PRECISION,
  sample_count INTEGER NOT NULL DEFAULT 0,
  oos_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  universe_asof TIMESTAMPTZ,
  evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  shadow_only BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_luna_alpha_eval_factor_time
  ON investment.luna_alpha_factor_evaluations (factor_id, evaluated_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_alpha_eval_market_time
  ON investment.luna_alpha_factor_evaluations (market, evaluated_at DESC);

INSERT INTO investment.luna_parameter_store
  (key, scope, value, tier, evidence, changed_by, effective_from)
SELECT key, scope, value::jsonb, tier, evidence::jsonb, changed_by, NOW()
FROM (VALUES
  ('c12.alpha.min_ic', 'global', '0.03', 'auto', '{"source":"CODEX_LUNA_ALPHA_FACTOR","component":"alpha-factor-discovery"}', 'system'),
  ('c12.alpha.min_rank_ir', 'global', '0.5', 'auto', '{"source":"CODEX_LUNA_ALPHA_FACTOR","component":"alpha-factor-discovery"}', 'system'),
  ('c12.alpha.min_sample_days', 'global', '60', 'auto', '{"source":"CODEX_LUNA_ALPHA_FACTOR","component":"alpha-factor-discovery"}', 'system'),
  ('c12.alpha.permutation_p_max', 'global', '0.01', 'auto', '{"source":"CODEX_LUNA_ALPHA_FACTOR","component":"alpha-factor-discovery"}', 'system'),
  ('c12.alpha.max_complexity', 'global', '12', 'auto', '{"source":"CODEX_LUNA_ALPHA_FACTOR","component":"alpha-factor-discovery"}', 'system')
) AS seed(key, scope, value, tier, evidence, changed_by)
WHERE NOT EXISTS (
  SELECT 1
  FROM investment.luna_parameter_store ps
  WHERE ps.key = seed.key
    AND ps.scope = seed.scope
);
