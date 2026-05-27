-- LLM Auto-Routing 로그 테이블
-- Auto-Router가 자동으로 모델을 선택할 때마다 기록 (Shadow 포함)
CREATE TABLE IF NOT EXISTS hub.llm_auto_routing_log (
  id                BIGSERIAL PRIMARY KEY,
  agent             TEXT,
  caller_team       TEXT,
  task_type         TEXT,
  task_complexity   TEXT NOT NULL CHECK (task_complexity IN ('simple', 'medium', 'complex', 'rag')),
  prompt_chars      INTEGER,
  context_chars     INTEGER,

  -- Auto-Router 결정
  auto_model        TEXT NOT NULL,   -- anthropic_haiku / anthropic_sonnet / anthropic_opus
  manual_model      TEXT,            -- 요청자가 지정한 모델 (있으면)
  mode              TEXT NOT NULL CHECK (mode IN ('shadow', 'active')),
  model_overridden  BOOLEAN NOT NULL DEFAULT FALSE,
  complexity_score  NUMERIC(5,2),
  routing_signals   JSONB,           -- 점수 산출에 사용된 신호들

  -- 결과 추적
  selected_provider TEXT,
  latency_ms        INTEGER,
  cost_usd          NUMERIC(10,6),
  success           BOOLEAN,
  quality_score     NUMERIC(3,1),    -- LLM-as-judge 평가 (0-10)
  error_code        TEXT,

  fallback_chain    TEXT[],

  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_llm_auto_routing_log_created
  ON hub.llm_auto_routing_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_llm_auto_routing_log_agent
  ON hub.llm_auto_routing_log (agent, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_llm_auto_routing_log_complexity
  ON hub.llm_auto_routing_log (task_complexity, auto_model, created_at DESC);
