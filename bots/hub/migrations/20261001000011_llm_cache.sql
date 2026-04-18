CREATE TABLE IF NOT EXISTS llm_cache (
  id BIGSERIAL PRIMARY KEY,
  prompt_hash TEXT UNIQUE NOT NULL,
  abstract_model TEXT NOT NULL,
  system_prompt_hash TEXT,
  response TEXT NOT NULL,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd NUMERIC(8,6),
  cache_type TEXT DEFAULT 'default',
  hit_count INTEGER DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  inserted_at TIMESTAMPTZ DEFAULT NOW(),
  last_hit_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_llm_cache_hash ON llm_cache(prompt_hash);
CREATE INDEX IF NOT EXISTS idx_llm_cache_expires ON llm_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_llm_cache_type ON llm_cache(cache_type, expires_at);

CREATE MATERIALIZED VIEW IF NOT EXISTS llm_cache_stats AS
SELECT
  DATE_TRUNC('day', inserted_at) AS day,
  cache_type,
  abstract_model,
  COUNT(*) AS total_entries,
  SUM(hit_count) AS total_hits,
  SUM(cost_usd * hit_count) AS cost_saved_usd,
  AVG(tokens_in + tokens_out) AS avg_tokens
FROM llm_cache
WHERE inserted_at > NOW() - INTERVAL '30 days'
GROUP BY DATE_TRUNC('day', inserted_at), cache_type, abstract_model
ORDER BY day DESC, cost_saved_usd DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_llm_cache_stats_day_model ON llm_cache_stats(day, cache_type, abstract_model);
