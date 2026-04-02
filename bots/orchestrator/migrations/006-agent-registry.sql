BEGIN;

CREATE SCHEMA IF NOT EXISTS agent;

CREATE TABLE IF NOT EXISTS agent.registry (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  team TEXT NOT NULL,
  role TEXT NOT NULL,
  specialty TEXT,
  llm_model TEXT,
  llm_fallback TEXT,
  score NUMERIC(4,2) DEFAULT 5.00,
  total_tasks INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  emotion_state JSONB DEFAULT '{"confidence":5,"fatigue":0,"motivation":5}'::JSONB,
  status TEXT DEFAULT 'idle',
  is_always_on BOOLEAN DEFAULT FALSE,
  dot_character JSONB DEFAULT '{}'::JSONB,
  code_path TEXT,
  config JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent.performance_history (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER REFERENCES agent.registry(id),
  score NUMERIC(4,2),
  task_description TEXT,
  result TEXT,
  confidence_reported NUMERIC(3,1),
  duration_ms INTEGER,
  tokens_used INTEGER,
  cost_usd NUMERIC(8,4),
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent.contracts (
  id SERIAL PRIMARY KEY,
  agent_id INTEGER REFERENCES agent.registry(id),
  employer_team TEXT NOT NULL,
  task TEXT NOT NULL,
  requirements JSONB,
  reward_config JSONB,
  penalty_config JSONB,
  status TEXT DEFAULT 'active',
  score_result NUMERIC(4,2),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_agent_team ON agent.registry(team);
CREATE INDEX IF NOT EXISTS idx_agent_status ON agent.registry(status);
CREATE INDEX IF NOT EXISTS idx_agent_score ON agent.registry(score DESC);
CREATE INDEX IF NOT EXISTS idx_perf_agent_id ON agent.performance_history(agent_id);
CREATE INDEX IF NOT EXISTS idx_perf_recorded ON agent.performance_history(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_contract_agent ON agent.contracts(agent_id);
CREATE INDEX IF NOT EXISTS idx_contract_status ON agent.contracts(status);

COMMIT;
