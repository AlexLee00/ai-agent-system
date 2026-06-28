CREATE SCHEMA IF NOT EXISTS hub;

CREATE TABLE IF NOT EXISTS hub.llm_recommender_weight_shadow (
  id                                 BIGSERIAL PRIMARY KEY,
  created_at                         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  days                               INTEGER NOT NULL,
  min_samples                        INTEGER NOT NULL,
  status                             TEXT NOT NULL,
  shadow_only                        BOOLEAN NOT NULL DEFAULT TRUE,
  live_mutation                      BOOLEAN NOT NULL DEFAULT FALSE,
  promotion_ready                    BOOLEAN NOT NULL DEFAULT FALSE,
  manual_promotion_review_candidate  BOOLEAN NOT NULL DEFAULT FALSE,
  base_weights                       JSONB NOT NULL,
  weights                            JSONB NOT NULL,
  deltas                             JSONB NOT NULL,
  metrics                            JSONB NOT NULL,
  reasons                            JSONB NOT NULL,
  blockers                           JSONB NOT NULL,
  report                             JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_llm_recommender_weight_shadow_created_at
  ON hub.llm_recommender_weight_shadow (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_llm_recommender_weight_shadow_status
  ON hub.llm_recommender_weight_shadow (status, created_at DESC);
