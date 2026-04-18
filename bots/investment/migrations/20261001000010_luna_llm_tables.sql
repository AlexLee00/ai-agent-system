CREATE TABLE IF NOT EXISTS luna_llm_routing_log (
  id BIGSERIAL PRIMARY KEY,
  agent_name TEXT NOT NULL,
  model_primary TEXT,
  model_used TEXT,
  fallback_used BOOLEAN DEFAULT false,
  prompt_tokens INTEGER,
  response_tokens INTEGER,
  latency_ms INTEGER,
  cost_usd NUMERIC(8,6),
  response_ok BOOLEAN NOT NULL,
  error_reason TEXT,
  urgency TEXT,
  task_type TEXT,
  budget_ratio NUMERIC(3,2),
  recommended_reason TEXT,
  provider TEXT,
  inserted_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_luna_llm_routing_agent ON luna_llm_routing_log(agent_name, inserted_at DESC);
CREATE INDEX idx_luna_llm_routing_ok ON luna_llm_routing_log(response_ok, inserted_at DESC);

CREATE TABLE IF NOT EXISTS luna_llm_cost_tracking (
  id BIGSERIAL PRIMARY KEY,
  agent_name TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  cost_usd NUMERIC(8,6) DEFAULT 0,
  inserted_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_luna_llm_cost_agent ON luna_llm_cost_tracking(agent_name, inserted_at DESC);
CREATE INDEX idx_luna_llm_cost_inserted ON luna_llm_cost_tracking(inserted_at DESC);

CREATE TABLE IF NOT EXISTS luna_llm_cost_daily (
  date DATE PRIMARY KEY,
  total_cost_usd NUMERIC(8,4) DEFAULT 0,
  total_tokens_in BIGINT DEFAULT 0,
  total_tokens_out BIGINT DEFAULT 0,
  by_agent JSONB DEFAULT '{}',
  by_model JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
