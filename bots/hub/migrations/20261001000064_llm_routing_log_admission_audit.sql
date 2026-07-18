ALTER TABLE public.llm_routing_log
  ADD COLUMN IF NOT EXISTS admission_rejections JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS admission_fallback_count INTEGER NOT NULL DEFAULT 0;

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
  admission_rejections,
  admission_fallback_count,
  route_target_kind,
  runtime_purpose,
  estimated_cost_usd,
  budget_guard_status,
  provider_tier
FROM public.llm_routing_log;
