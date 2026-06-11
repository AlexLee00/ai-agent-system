-- Luna P1-3: C2 HMM regime engine shadow facade + calibration
-- Additive only. Runtime decision paths do not consume these fields.

CREATE SCHEMA IF NOT EXISTS investment;

ALTER TABLE investment.hmm_regime_log
  ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'hmm',
  ADD COLUMN IF NOT EXISTS transition_alert JSONB;

CREATE INDEX IF NOT EXISTS idx_hmm_regime_log_market_sentinel_created
  ON investment.hmm_regime_log (market, created_at DESC)
  WHERE symbol = '__market__';

CREATE TABLE IF NOT EXISTS investment.luna_regime_calibration (
  id              BIGSERIAL PRIMARY KEY,
  market          TEXT NOT NULL CHECK (market IN ('domestic', 'overseas', 'crypto')),
  as_of_date      DATE NOT NULL,
  brier_hmm       NUMERIC,
  brier_fallback  NUMERIC,
  label           TEXT NOT NULL CHECK (label IN ('bull', 'bear', 'sideways', 'volatile')),
  probs           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (market, as_of_date)
);

ALTER TABLE investment.luna_regime_calibration
  ADD COLUMN IF NOT EXISTS market TEXT,
  ADD COLUMN IF NOT EXISTS as_of_date DATE,
  ADD COLUMN IF NOT EXISTS brier_hmm NUMERIC,
  ADD COLUMN IF NOT EXISTS brier_fallback NUMERIC,
  ADD COLUMN IF NOT EXISTS label TEXT,
  ADD COLUMN IF NOT EXISTS probs JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_luna_regime_calibration_market_date
  ON investment.luna_regime_calibration (market, as_of_date DESC);

WITH seed(key, value, scope, tier, effective_from, evidence, changed_by) AS (
  VALUES
    ('c2.transition_alert_threshold', '0.15'::jsonb, 'global', 'auto', NOW(), 'LUNA P1-3 C2 transition alert threshold', 'meeting'),
    ('c2.transition_alert_cooldown_hours', '4'::jsonb, 'global', 'auto', NOW(), 'LUNA P1-3 C2 transition alert cooldown', 'meeting'),
    ('c2.transition_alert_daily_limit', '1'::jsonb, 'global', 'auto', NOW(), 'LUNA P1-3 C2 transition alert daily limit', 'meeting')
)
INSERT INTO investment.luna_parameter_store (key, value, scope, tier, effective_from, evidence, changed_by)
SELECT key, value, scope, tier, effective_from, evidence, changed_by
  FROM seed
 WHERE NOT EXISTS (
   SELECT 1
     FROM investment.luna_parameter_store existing
    WHERE existing.key = seed.key
      AND existing.scope = seed.scope
      AND existing.evidence = seed.evidence
      AND existing.effective_from <= NOW()
 );

COMMENT ON TABLE investment.luna_regime_calibration IS
  'Luna P1-3 shadow-only C2 regime calibration: HMM/fallback probabilities scored against realized labels.';
