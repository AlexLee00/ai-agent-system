BEGIN;

CREATE SCHEMA IF NOT EXISTS agent;

CREATE TABLE IF NOT EXISTS agent.skills (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  team VARCHAR(50),
  category VARCHAR(50) NOT NULL,
  code_path VARCHAR(255),
  description TEXT,
  input_schema JSONB DEFAULT '{}'::jsonb,
  output_schema JSONB DEFAULT '{}'::jsonb,
  score NUMERIC(4,2) DEFAULT 5.00,
  usage_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  avg_latency_ms INTEGER,
  status VARCHAR(20) DEFAULT 'active',
  config JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_skills_team ON agent.skills(team);
CREATE INDEX IF NOT EXISTS idx_skills_category ON agent.skills(category);
CREATE INDEX IF NOT EXISTS idx_skills_score ON agent.skills(score DESC);

CREATE TABLE IF NOT EXISTS agent.tools (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  display_name VARCHAR(100) NOT NULL,
  type VARCHAR(20) NOT NULL,
  team VARCHAR(50),
  endpoint VARCHAR(500),
  capabilities JSONB DEFAULT '[]'::jsonb,
  auth_config JSONB DEFAULT '{}'::jsonb,
  score NUMERIC(4,2) DEFAULT 5.00,
  usage_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  avg_latency_ms INTEGER,
  cost_per_call NUMERIC(10,6) DEFAULT 0,
  status VARCHAR(20) DEFAULT 'active',
  config JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tools_team ON agent.tools(team);
CREATE INDEX IF NOT EXISTS idx_tools_type ON agent.tools(type);
CREATE INDEX IF NOT EXISTS idx_tools_capabilities ON agent.tools USING GIN(capabilities);

COMMIT;
