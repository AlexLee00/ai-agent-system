BEGIN;

CREATE TABLE IF NOT EXISTS agent.competitions (
  id SERIAL PRIMARY KEY,
  team TEXT NOT NULL DEFAULT 'blog',
  topic TEXT NOT NULL,

  group_a_agents JSONB,
  group_a_contract_ids JSONB,
  group_a_result JSONB,

  group_b_agents JSONB,
  group_b_contract_ids JSONB,
  group_b_result JSONB,

  winner TEXT,
  quality_diff NUMERIC(4,2),
  winning_pattern JSONB,
  evaluation_detail JSONB,

  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_comp_team ON agent.competitions(team);
CREATE INDEX IF NOT EXISTS idx_comp_status ON agent.competitions(status);
CREATE INDEX IF NOT EXISTS idx_comp_created ON agent.competitions(created_at DESC);

COMMIT;
