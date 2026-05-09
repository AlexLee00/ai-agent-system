ALTER TABLE public.llm_routing_log
  ADD COLUMN IF NOT EXISTS selector_key TEXT,
  ADD COLUMN IF NOT EXISTS selected_route TEXT,
  ADD COLUMN IF NOT EXISTS runtime_profile TEXT,
  ADD COLUMN IF NOT EXISTS attempted_providers JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS avoided_providers JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_llm_routing_log_selector_key
  ON public.llm_routing_log (selector_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_llm_routing_log_selected_route
  ON public.llm_routing_log (selected_route, created_at DESC);
