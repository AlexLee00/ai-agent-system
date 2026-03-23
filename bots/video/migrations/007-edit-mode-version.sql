-- Phase 2(auto) vs Phase 3(interactive) 구분 + 버전 추적

ALTER TABLE public.video_edits
  ADD COLUMN IF NOT EXISTS edit_mode TEXT DEFAULT 'auto';

ALTER TABLE public.video_edits
  ADD COLUMN IF NOT EXISTS phase3_version INTEGER DEFAULT NULL;

ALTER TABLE public.video_edits
  ADD COLUMN IF NOT EXISTS phase3_latest_dir TEXT DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_video_edits_mode
  ON public.video_edits(edit_mode);
