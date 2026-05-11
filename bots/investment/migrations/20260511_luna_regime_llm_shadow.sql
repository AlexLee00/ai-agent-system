-- Phase 1: LLM 체제 분석 Shadow 비교 테이블
-- 규칙 기반 vs LLM 판단 일치율 추적 (Shadow Mode 1주 운영)
CREATE TABLE IF NOT EXISTS investment.luna_regime_llm_shadow (
  id              BIGSERIAL    PRIMARY KEY,
  market          TEXT         NOT NULL,  -- 'crypto' | 'domestic' | 'overseas'
  rule_regime     TEXT         NOT NULL,  -- 규칙 기반 체제
  rule_confidence NUMERIC(5,3) DEFAULT 0.5,
  llm_regime      TEXT         NOT NULL,  -- LLM 판단 체제
  llm_confidence  NUMERIC(5,3) DEFAULT 0.5,
  llm_rationale   TEXT,
  llm_duration    TEXT,
  llm_key_signals JSONB        DEFAULT '[]',
  match           BOOLEAN      GENERATED ALWAYS AS (rule_regime = llm_regime) STORED,
  captured_at     TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_luna_regime_llm_shadow_market_captured
  ON investment.luna_regime_llm_shadow (market, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_luna_regime_llm_shadow_match
  ON investment.luna_regime_llm_shadow (match, captured_at DESC);
