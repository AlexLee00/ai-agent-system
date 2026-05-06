ALTER TABLE public.llm_routing_log
  ADD COLUMN IF NOT EXISTS prompt_hash TEXT,
  ADD COLUMN IF NOT EXISTS system_prompt_hash TEXT,
  ADD COLUMN IF NOT EXISTS request_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS prompt_chars INTEGER;

CREATE INDEX IF NOT EXISTS idx_llm_routing_log_prompt_hash
  ON public.llm_routing_log (prompt_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_llm_routing_log_request_fingerprint
  ON public.llm_routing_log (request_fingerprint, created_at DESC);
