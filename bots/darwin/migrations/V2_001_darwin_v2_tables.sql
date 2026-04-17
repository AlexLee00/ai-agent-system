-- Darwin V2 Tables
-- 생성일: 2026-04-18
-- 목적: Darwin V2 연구 파이프라인을 위한 핵심 테이블 정의

-- 1. LLM 라우팅 로그
CREATE TABLE IF NOT EXISTS darwin_v2_llm_routing_log (
  id BIGSERIAL PRIMARY KEY,
  agent_name VARCHAR(100) NOT NULL,
  model_primary VARCHAR(100),
  model_used VARCHAR(100),
  fallback_used BOOLEAN DEFAULT false,
  tokens_input INTEGER DEFAULT 0,
  tokens_output INTEGER DEFAULT 0,
  latency_ms INTEGER,
  cost_usd NUMERIC(10, 8) DEFAULT 0,
  response_ok BOOLEAN DEFAULT true,
  error_reason TEXT,
  urgency VARCHAR(20),
  task_type VARCHAR(50),
  budget_ratio NUMERIC(4, 3),
  recommended_reason TEXT,
  inserted_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_darwin_routing_agent ON darwin_v2_llm_routing_log(agent_name, inserted_at);
CREATE INDEX IF NOT EXISTS idx_darwin_routing_model ON darwin_v2_llm_routing_log(model_used, response_ok);

-- 2. LLM 비용 추적
CREATE TABLE IF NOT EXISTS darwin_llm_cost_tracking (
  id BIGSERIAL PRIMARY KEY,
  agent_name VARCHAR(100) NOT NULL,
  model VARCHAR(100) NOT NULL,
  tokens_input INTEGER DEFAULT 0,
  tokens_output INTEGER DEFAULT 0,
  cost_usd NUMERIC(10, 8) DEFAULT 0,
  date DATE DEFAULT CURRENT_DATE,
  inserted_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_darwin_cost_date ON darwin_llm_cost_tracking(date, agent_name);

-- 3. Darwin 에이전트 메모리 (pgvector)
CREATE TABLE IF NOT EXISTS darwin_agent_memory (
  id BIGSERIAL PRIMARY KEY,
  team VARCHAR(50) DEFAULT 'darwin',
  content TEXT NOT NULL,
  embedding vector(1024),
  memory_type VARCHAR(50) DEFAULT 'episodic',
  importance NUMERIC(3, 2) DEFAULT 0.5,
  context JSONB DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',
  inserted_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_darwin_memory_team ON darwin_agent_memory(team, memory_type);
CREATE INDEX IF NOT EXISTS idx_darwin_memory_embedding ON darwin_agent_memory USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50);

-- 4. Darwin 에이전트 프롬프트 (ESPL 진화)
CREATE TABLE IF NOT EXISTS darwin_agent_prompts (
  id BIGSERIAL PRIMARY KEY,
  agent_name VARCHAR(100) NOT NULL,
  prompt TEXT NOT NULL,
  generation INTEGER DEFAULT 1,
  status VARCHAR(20) DEFAULT 'operational',
  effectiveness NUMERIC(4, 3),
  parent_ids INTEGER[],
  evolution_op VARCHAR(20),
  inserted_at TIMESTAMPTZ DEFAULT NOW(),
  promoted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_darwin_prompts_agent ON darwin_agent_prompts(agent_name, status);

-- 5. 섀도우 실행 (v1 vs v2 비교)
CREATE TABLE IF NOT EXISTS darwin_v2_shadow_runs (
  id BIGSERIAL PRIMARY KEY,
  run_date DATE DEFAULT CURRENT_DATE,
  v1_result JSONB DEFAULT '{}',
  v2_result JSONB DEFAULT '{}',
  match_score NUMERIC(4, 3),
  differences JSONB DEFAULT '[]',
  phase VARCHAR(50),
  duration_ms INTEGER,
  inserted_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_darwin_shadow_date ON darwin_v2_shadow_runs(run_date);

-- 6. Darwin 연구 파이프라인 감사 로그
CREATE TABLE IF NOT EXISTS darwin_v2_pipeline_audit (
  id BIGSERIAL PRIMARY KEY,
  paper_id BIGINT REFERENCES reservation.rag_research(id),
  pipeline_stage VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL,
  autonomy_level INTEGER DEFAULT 3,
  model_used VARCHAR(100),
  cost_usd NUMERIC(10, 8) DEFAULT 0,
  duration_ms INTEGER,
  result JSONB DEFAULT '{}',
  error_reason TEXT,
  inserted_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_darwin_audit_paper ON darwin_v2_pipeline_audit(paper_id, pipeline_stage);
CREATE INDEX IF NOT EXISTS idx_darwin_audit_stage ON darwin_v2_pipeline_audit(pipeline_stage, inserted_at);

-- 7. Darwin 구현 계획 (Planner 산출물)
CREATE TABLE IF NOT EXISTS darwin_implementation_plans (
  id BIGSERIAL PRIMARY KEY,
  paper_url TEXT NOT NULL,
  paper_title TEXT,
  atomic_components JSONB DEFAULT '[]',
  code_skeletons JSONB DEFAULT '{}',
  formula_code_map JSONB DEFAULT '{}',
  resource_estimate JSONB DEFAULT '{}',
  implementation_plan JSONB DEFAULT '[]',
  status VARCHAR(20) DEFAULT 'pending',
  assigned_to VARCHAR(50) DEFAULT 'edison',
  inserted_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_darwin_plans_status ON darwin_implementation_plans(status, inserted_at);
