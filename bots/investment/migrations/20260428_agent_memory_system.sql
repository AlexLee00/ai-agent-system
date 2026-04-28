-- ─── Agent Memory System — Phase A/B/C/G ──────────────────────────────────────
-- 2026-04-28 | CODEX_LUNA_AGENT_MEMORY_AND_LLM_ROUTING_PLAN

-- ─── Phase B-2: Layer 2 단기 메모리 (TTL 24h) ────────────────────────────────

CREATE TABLE IF NOT EXISTS investment.agent_short_term_memory (
  id           BIGSERIAL    PRIMARY KEY,
  agent_name   TEXT         NOT NULL,
  incident_key TEXT,
  symbol       TEXT,
  market       TEXT,        -- crypto | domestic | overseas
  content      JSONB        NOT NULL DEFAULT '{}',
  expires_at   TIMESTAMPTZ  NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 활성 레코드만 빠른 조회 (TTL 24h 기준)
CREATE INDEX IF NOT EXISTS idx_agent_stm_active
  ON investment.agent_short_term_memory (agent_name, symbol, expires_at)
  WHERE expires_at > NOW();

CREATE INDEX IF NOT EXISTS idx_agent_stm_incident
  ON investment.agent_short_term_memory (incident_key, agent_name)
  WHERE incident_key IS NOT NULL;

-- ─── Phase B-3: luna_rag_documents 확장 (Layer 3 에이전트 분리) ─────────────

-- owner_agent 컬럼 추가 (에이전트별 episodic memory 분리)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'luna_rag_documents'
       AND column_name = 'owner_agent'
  ) THEN
    ALTER TABLE luna_rag_documents ADD COLUMN owner_agent TEXT;
  END IF;
END $$;

-- owner_agent 기준 최신순 인덱스
CREATE INDEX IF NOT EXISTS idx_luna_rag_owner_agent
  ON luna_rag_documents (owner_agent, category, created_at DESC)
  WHERE owner_agent IS NOT NULL;

-- ─── Phase B-4: Layer 4 Semantic Memory (entity_facts) ───────────────────────

CREATE TABLE IF NOT EXISTS investment.entity_facts (
  id                      BIGSERIAL    PRIMARY KEY,
  entity                  TEXT         NOT NULL,  -- symbol, market, sector
  entity_type             TEXT         NOT NULL,  -- 'symbol' | 'market' | 'sector' | 'pattern'
  fact                    TEXT         NOT NULL,
  confidence              NUMERIC(3,2) NOT NULL DEFAULT 0.70,
  source                  TEXT,                   -- 'trade_review' | 'manual' | 'auto_extract'
  derived_from_trade_ids  BIGINT[]     DEFAULT '{}',
  valid_from              TIMESTAMPTZ  DEFAULT NOW(),
  valid_until             TIMESTAMPTZ,            -- NULL = 영구 유효
  created_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- entity별 최신 fact 조회
CREATE INDEX IF NOT EXISTS idx_entity_facts_lookup
  ON investment.entity_facts (entity, entity_type, created_at DESC);

-- 신뢰도 필터
CREATE INDEX IF NOT EXISTS idx_entity_facts_confidence
  ON investment.entity_facts (confidence DESC)
  WHERE confidence >= 0.70;

-- ─── Phase D: Curriculum Learning State ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS investment.agent_curriculum_state (
  id                BIGSERIAL    PRIMARY KEY,
  agent_name        TEXT         NOT NULL,
  market            TEXT         NOT NULL DEFAULT 'any',
  invocation_count  INT          NOT NULL DEFAULT 0,
  success_count     INT          NOT NULL DEFAULT 0,
  failure_count     INT          NOT NULL DEFAULT 0,
  current_level     TEXT         NOT NULL DEFAULT 'novice',
                                            -- novice | intermediate | expert
  config            JSONB        NOT NULL DEFAULT '{}',
  last_promoted_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  UNIQUE (agent_name, market)
);

CREATE INDEX IF NOT EXISTS idx_curriculum_agent_market
  ON investment.agent_curriculum_state (agent_name, market);

-- ─── Phase E: Cross-Agent Message Bus ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS investment.agent_messages (
  id           BIGSERIAL    PRIMARY KEY,
  incident_key TEXT,
  from_agent   TEXT         NOT NULL,
  to_agent     TEXT         NOT NULL,
  message_type TEXT         NOT NULL DEFAULT 'query',
                                       -- query | response | broadcast
  payload      JSONB        NOT NULL DEFAULT '{}',
  responded_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_incident
  ON investment.agent_messages (incident_key, created_at DESC)
  WHERE incident_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_messages_to_agent
  ON investment.agent_messages (to_agent, responded_at)
  WHERE responded_at IS NULL;

-- ─── Phase A: Agent Persona/Constitution 로딩 추적 ───────────────────────────

CREATE TABLE IF NOT EXISTS investment.agent_context_log (
  id              BIGSERIAL    PRIMARY KEY,
  agent_name      TEXT         NOT NULL,
  call_id         TEXT,
  persona_loaded  BOOLEAN      DEFAULT false,
  constitution_loaded BOOLEAN  DEFAULT false,
  rag_docs_count  INT          DEFAULT 0,
  failures_found  INT          DEFAULT 0,
  skills_found    INT          DEFAULT 0,
  total_prefix_chars INT       DEFAULT 0,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_context_log_agent
  ON investment.agent_context_log (agent_name, created_at DESC);

-- ─── Phase G: LLM 호출 실패 reflexion ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS investment.llm_failure_reflexions (
  id              BIGSERIAL    PRIMARY KEY,
  agent_name      TEXT         NOT NULL,
  market          TEXT,
  task_type       TEXT,
  provider        TEXT,
  error_type      TEXT,        -- 'timeout' | 'rate_limit' | 'parse_fail' | 'bad_response'
  prompt_hash     TEXT,        -- SHA256(prompt) — 동일 프롬프트 반복 실패 감지
  failure_count   INT          NOT NULL DEFAULT 1,
  last_failed_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  avoid_provider  TEXT,        -- 다음 호출 시 이 provider 피하기
  reformulation   TEXT,        -- 개선된 프롬프트 패턴 (있으면)
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_failure_agent_hash
  ON investment.llm_failure_reflexions (agent_name, prompt_hash, provider);

CREATE INDEX IF NOT EXISTS idx_llm_failure_recent
  ON investment.llm_failure_reflexions (agent_name, last_failed_at DESC);

-- ─── 만료 레코드 정리 함수 ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION investment.cleanup_expired_short_term_memory()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM investment.agent_short_term_memory
   WHERE expires_at < NOW() - INTERVAL '1 hour';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
