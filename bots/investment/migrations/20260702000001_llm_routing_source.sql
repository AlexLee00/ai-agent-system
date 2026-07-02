-- Luna YAML routing observability source tag.
-- Apply manually after review:
--   psql -d jay -f bots/investment/migrations/20260702000001_llm_routing_source.sql

ALTER TABLE investment.llm_routing_log
  ADD COLUMN IF NOT EXISTS routing_source TEXT;

CREATE INDEX IF NOT EXISTS idx_llm_routing_log_routing_source_created
  ON investment.llm_routing_log (routing_source, created_at DESC);
