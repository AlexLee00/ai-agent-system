-- luna_regime_weight_snapshots — 체제별 동적 가중치 학습 스냅샷
-- regime-weight-learner INSERT 대상 테이블 보강
-- 생성: 2026-05-28

CREATE SCHEMA IF NOT EXISTS investment;

CREATE TABLE IF NOT EXISTS investment.luna_regime_weight_snapshots (
  id                 BIGSERIAL PRIMARY KEY,
  regime             TEXT,
  fusion_weights     JSONB,
  signal_weights     JSONB,
  universe_weights   JSONB,
  win_rate           NUMERIC,
  profit_factor      NUMERIC,
  performance_metric NUMERIC,
  total_trades       INT,
  learn_rate         NUMERIC,
  created_at         TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE investment.luna_regime_weight_snapshots
  ADD COLUMN IF NOT EXISTS regime TEXT,
  ADD COLUMN IF NOT EXISTS fusion_weights JSONB,
  ADD COLUMN IF NOT EXISTS signal_weights JSONB,
  ADD COLUMN IF NOT EXISTS universe_weights JSONB,
  ADD COLUMN IF NOT EXISTS win_rate NUMERIC,
  ADD COLUMN IF NOT EXISTS profit_factor NUMERIC,
  ADD COLUMN IF NOT EXISTS performance_metric NUMERIC,
  ADD COLUMN IF NOT EXISTS total_trades INT,
  ADD COLUMN IF NOT EXISTS learn_rate NUMERIC,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_luna_regime_weight_snapshots_regime_time
  ON investment.luna_regime_weight_snapshots (regime, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_regime_weight_snapshots_time
  ON investment.luna_regime_weight_snapshots (created_at DESC);

COMMENT ON TABLE investment.luna_regime_weight_snapshots IS
  '체제별 fusion/signal/universe 가중치 학습 이력 — regime-weight-learner 기록 대상';
