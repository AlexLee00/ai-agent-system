-- Hub Remodel HBs1-HBs4 routing-log standard columns.
-- Draft only. Do not apply without master approval.

ALTER TABLE public.llm_routing_log
  ADD COLUMN IF NOT EXISTS routing_source TEXT,
  ADD COLUMN IF NOT EXISTS fallback_used BOOLEAN,
  ADD COLUMN IF NOT EXISTS fallback_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS latency_ms INTEGER;

CREATE INDEX IF NOT EXISTS idx_llm_routing_log_routing_source_created
  ON public.llm_routing_log (routing_source, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_llm_routing_log_fallback_used_created
  ON public.llm_routing_log (fallback_used, created_at DESC)
  WHERE fallback_used IS TRUE;
