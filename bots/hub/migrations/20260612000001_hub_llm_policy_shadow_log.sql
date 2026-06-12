CREATE SCHEMA IF NOT EXISTS hub;

CREATE TABLE IF NOT EXISTS hub.llm_policy_shadow_log (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  selector_key TEXT NOT NULL,
  ctx JSONB NOT NULL DEFAULT '{}'::jsonb,
  match BOOLEAN NOT NULL,
  old_chain JSONB NOT NULL DEFAULT '[]'::jsonb,
  new_chain JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_hub_llm_policy_shadow_log_created_at
  ON hub.llm_policy_shadow_log (created_at);

CREATE INDEX IF NOT EXISTS idx_hub_llm_policy_shadow_log_match
  ON hub.llm_policy_shadow_log (match);
