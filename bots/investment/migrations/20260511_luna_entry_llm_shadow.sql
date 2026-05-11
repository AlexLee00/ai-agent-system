-- Phase 2: Entry Decision LLM Shadow 비교 테이블
-- 기존 fixed threshold 진입 판단 vs LLM dynamic threshold 판단을 Shadow Mode로 추적
CREATE TABLE IF NOT EXISTS investment.luna_entry_llm_shadow (
  id                       BIGSERIAL PRIMARY KEY,
  trigger_id               TEXT,
  symbol                   TEXT NOT NULL,
  exchange                 TEXT NOT NULL DEFAULT 'binance',
  market                   TEXT NOT NULL DEFAULT 'crypto',
  trigger_type             TEXT,
  deterministic_fire       BOOLEAN NOT NULL DEFAULT false,
  deterministic_reason     TEXT,
  deterministic_confidence NUMERIC(5,3) DEFAULT 0.0,
  rule_regime              TEXT,
  llm_regime               TEXT,
  llm_fire                 BOOLEAN NOT NULL DEFAULT false,
  llm_confidence           NUMERIC(5,3) DEFAULT 0.0,
  dynamic_threshold        NUMERIC(5,3) DEFAULT 0.7,
  position_size_pct        NUMERIC(5,3) DEFAULT 0.1,
  reasoning                TEXT,
  risk_assessment          JSONB DEFAULT '{}'::jsonb,
  n_agent_debate           JSONB DEFAULT '{}'::jsonb,
  context_evidence         JSONB DEFAULT '{}'::jsonb,
  match                    BOOLEAN GENERATED ALWAYS AS (deterministic_fire = llm_fire) STORED,
  observed_at              TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE investment.luna_entry_llm_shadow
  ADD COLUMN IF NOT EXISTS context_evidence JSONB DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_luna_entry_llm_shadow_trigger_observed
  ON investment.luna_entry_llm_shadow (trigger_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_entry_llm_shadow_symbol_observed
  ON investment.luna_entry_llm_shadow (exchange, symbol, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_entry_llm_shadow_match
  ON investment.luna_entry_llm_shadow (match, observed_at DESC);
