-- 012: sigma team memory — Phase A 4-Layer Memory 통합 인프라
-- team-memory-adapter.ts 에서 initSchema() 로 자동 생성되므로 수동 실행 선택 사항.

CREATE SCHEMA IF NOT EXISTS sigma;

-- Layer 2: Short-term Memory (24h TTL, 9팀 공용)
CREATE TABLE IF NOT EXISTS sigma.agent_short_term_memory (
  id BIGSERIAL PRIMARY KEY,
  team TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  content JSONB NOT NULL DEFAULT '{}',
  context JSONB NOT NULL DEFAULT '{}',
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sigma_stm_team_agent
  ON sigma.agent_short_term_memory (team, agent_name, expires_at);

-- Layer 4-Semantic: Entity Facts (신뢰도 기반 사실 저장)
CREATE TABLE IF NOT EXISTS sigma.entity_facts (
  id BIGSERIAL PRIMARY KEY,
  team TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_type TEXT NOT NULL DEFAULT 'general',
  fact TEXT NOT NULL,
  confidence NUMERIC(4,3) NOT NULL DEFAULT 0.700,
  source_event_id BIGINT,
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (team, agent_name, entity, entity_type)
);

CREATE INDEX IF NOT EXISTS idx_sigma_ef_team_entity
  ON sigma.entity_facts (team, agent_name, entity, confidence DESC);

-- cleanup: 만료된 short-term 삭제 (선택 실행)
-- DELETE FROM sigma.agent_short_term_memory WHERE expires_at < NOW() - INTERVAL '1 hour';
