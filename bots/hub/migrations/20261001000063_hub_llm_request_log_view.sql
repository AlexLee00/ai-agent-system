ALTER TABLE public.llm_routing_log
  ADD COLUMN IF NOT EXISTS prompt_hash TEXT,
  ADD COLUMN IF NOT EXISTS system_prompt_hash TEXT,
  ADD COLUMN IF NOT EXISTS request_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS prompt_chars INTEGER,
  ADD COLUMN IF NOT EXISTS selector_key TEXT,
  ADD COLUMN IF NOT EXISTS selected_route TEXT,
  ADD COLUMN IF NOT EXISTS runtime_profile TEXT,
  ADD COLUMN IF NOT EXISTS attempted_providers JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS avoided_providers JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS request_id TEXT,
  ADD COLUMN IF NOT EXISTS route_target_kind TEXT,
  ADD COLUMN IF NOT EXISTS runtime_purpose TEXT,
  ADD COLUMN IF NOT EXISTS estimated_cost_usd DOUBLE PRECISION DEFAULT 0,
  ADD COLUMN IF NOT EXISTS budget_guard_status TEXT,
  ADD COLUMN IF NOT EXISTS provider_tier TEXT;

CREATE INDEX IF NOT EXISTS idx_llm_routing_log_request_id
  ON public.llm_routing_log (request_id);

CREATE INDEX IF NOT EXISTS idx_llm_routing_log_runtime_purpose
  ON public.llm_routing_log (caller_team, runtime_purpose, created_at DESC);

CREATE SCHEMA IF NOT EXISTS hub;

CREATE OR REPLACE VIEW hub.llm_request_log AS
SELECT
  id,
  COALESCE(request_id, session_id, id::text) AS request_id,
  created_at,
  provider,
  agent,
  caller_team,
  abstract_model,
  success,
  duration_ms,
  cost_usd,
  fallback_count,
  error,
  session_id,
  prompt_hash,
  system_prompt_hash,
  request_fingerprint,
  prompt_chars,
  selector_key,
  selected_route,
  runtime_profile,
  attempted_providers,
  avoided_providers,
  route_target_kind,
  runtime_purpose,
  estimated_cost_usd,
  budget_guard_status,
  provider_tier
FROM public.llm_routing_log;
