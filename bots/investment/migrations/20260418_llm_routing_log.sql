-- LUNA_REMODEL Phase 1: Investment LLM 라우팅 로그 테이블
-- Hub 경유 vs 직접 호출 Shadow 비교 + 라우팅 이력 추적

CREATE TABLE IF NOT EXISTS investment.llm_routing_log (
  id            BIGSERIAL   PRIMARY KEY,
  agent_name    TEXT        NOT NULL,                    -- 'luna','nemesis','hermes' 등
  hub_text      TEXT,                                    -- Hub 경유 응답 (Shadow/Hub 모드)
  direct_text   TEXT,                                    -- 직접 호출 응답 (Shadow 모드)
  matched       BOOLEAN,                                 -- 신호 일치 여부 (Shadow 비교)
  provider      TEXT,                                    -- 'claude-code-oauth','groq','failed'
  cost_usd      NUMERIC(12,8) DEFAULT 0,
  latency_ms    INTEGER       DEFAULT 0,
  market        TEXT,                                    -- 'crypto','domestic','overseas'
  symbol        TEXT,                                    -- 'BTC/USDT','005930','AAPL'
  shadow_mode   BOOLEAN       DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_llm_routing_log_agent_created
  ON investment.llm_routing_log (agent_name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_llm_routing_log_shadow
  ON investment.llm_routing_log (shadow_mode, created_at DESC)
  WHERE shadow_mode = true;

-- Shadow 일치율 빠른 조회
CREATE INDEX IF NOT EXISTS idx_llm_routing_log_matched
  ON investment.llm_routing_log (matched, created_at DESC);
