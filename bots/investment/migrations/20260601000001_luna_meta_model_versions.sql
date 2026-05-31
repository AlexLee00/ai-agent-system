-- luna_meta_model_versions: Secondary Model 학습 버전 관리
-- CODEX_LUNA_PHASE2_STAGE2_1_SECONDARY_MODEL_TRAIN_2026-06-01
-- SHADOW 모드 — active=false 기본. 단계 2-2에서 교체 로직 구현.

CREATE TABLE IF NOT EXISTS investment.luna_meta_model_versions (
  id              BIGSERIAL     PRIMARY KEY,
  version         TEXT          NOT NULL,
  trained_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  n_trades        INTEGER       NOT NULL,
  tier            INTEGER       NOT NULL DEFAULT 1,
  model_type      TEXT          NOT NULL DEFAULT 'logistic',
  auc             DOUBLE PRECISION,
  precision_score DOUBLE PRECISION,
  recall_score    DOUBLE PRECISION,
  f1_score        DOUBLE PRECISION,
  feature_names   JSONB         NOT NULL DEFAULT '[]'::jsonb,
  model_path      TEXT          NOT NULL,
  active          BOOLEAN       NOT NULL DEFAULT false,
  notes           TEXT
);

CREATE INDEX IF NOT EXISTS idx_luna_meta_model_versions_active
  ON investment.luna_meta_model_versions (active, trained_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_meta_model_versions_tier
  ON investment.luna_meta_model_versions (tier, trained_at DESC);

COMMENT ON TABLE investment.luna_meta_model_versions IS
  '루나 Secondary Model 학습 버전 — active=true가 현재 사용 모델 (단계 2-2에서 교체)';

COMMENT ON COLUMN investment.luna_meta_model_versions.active IS
  '단계 2-2 교체 로직이 성능 검증 후 true로 설정. 여기서는 기록만.';
