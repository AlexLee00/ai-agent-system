BEGIN;

CREATE TABLE IF NOT EXISTS agent.traces (
  id SERIAL PRIMARY KEY,
  trace_id TEXT NOT NULL,
  agent_name TEXT,
  team TEXT,
  task_type TEXT,
  model TEXT,
  provider TEXT,
  route TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER GENERATED ALWAYS AS (input_tokens + output_tokens) STORED,
  cost_usd NUMERIC(10,6) DEFAULT 0,
  latency_ms INTEGER DEFAULT 0,
  status TEXT DEFAULT 'success',
  error_message TEXT,
  fallback_used BOOLEAN DEFAULT FALSE,
  fallback_provider TEXT,
  confidence NUMERIC(3,1),
  quality_score NUMERIC(4,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_traces_agent ON agent.traces(agent_name);
CREATE INDEX IF NOT EXISTS idx_traces_team ON agent.traces(team);
CREATE INDEX IF NOT EXISTS idx_traces_created ON agent.traces(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_traces_route ON agent.traces(route);
CREATE INDEX IF NOT EXISTS idx_traces_provider ON agent.traces(provider);

COMMIT;
