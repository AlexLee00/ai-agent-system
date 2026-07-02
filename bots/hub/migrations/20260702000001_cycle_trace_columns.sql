-- CYCLE_TRACE read path support for Hub routing log.
-- Apply manually after review; runtime code records trace/cycle only when columns exist.

ALTER TABLE public.llm_routing_log
  ADD COLUMN IF NOT EXISTS trace_id TEXT,
  ADD COLUMN IF NOT EXISTS cycle_id TEXT;

CREATE INDEX IF NOT EXISTS idx_llm_routing_log_trace_id_created_at
  ON public.llm_routing_log (trace_id, created_at DESC)
  WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_llm_routing_log_cycle_id_created_at
  ON public.llm_routing_log (cycle_id, created_at DESC)
  WHERE cycle_id IS NOT NULL;

