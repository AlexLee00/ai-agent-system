-- Luna vault RAG learning SHADOW evidence.
-- 기존 agent-evolution 조정/커리큘럼은 변경하지 않고 base vs vault 비교만 기록한다.

CREATE TABLE IF NOT EXISTS investment.luna_vault_shadow_adjustments (
  id                   BIGSERIAL PRIMARY KEY,
  week                 TEXT,
  pattern_key          TEXT NOT NULL,
  market               TEXT,
  regime               TEXT,
  base_adjustment_type TEXT NOT NULL,
  vault_shadow_type    TEXT,
  vault_evidence       JSONB NOT NULL DEFAULT '{}'::jsonb,
  agreement            BOOLEAN,
  confidence           DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_luna_vault_shadow_adjustments_pattern
  ON investment.luna_vault_shadow_adjustments (pattern_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_vault_shadow_adjustments_market
  ON investment.luna_vault_shadow_adjustments (market, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_vault_shadow_adjustments_agreement
  ON investment.luna_vault_shadow_adjustments (agreement, created_at DESC);

COMMENT ON TABLE investment.luna_vault_shadow_adjustments IS
  'SHADOW: agent-evolution base adjustment vs sigma vault RAG evidence comparison';
