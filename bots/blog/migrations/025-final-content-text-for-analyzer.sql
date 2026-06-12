-- CODEX-B2c: store normalized final content for master-edit-analyzer.
-- Apply manually before enabling B2c write/analyze flow:
--   psql -d jay -f bots/blog/migrations/025-final-content-text-for-analyzer.sql

ALTER TABLE blog.final_content_checks
  ADD COLUMN IF NOT EXISTS final_title TEXT,
  ADD COLUMN IF NOT EXISTS final_content_text TEXT;

CREATE INDEX IF NOT EXISTS idx_final_content_checks_changed_text
  ON blog.final_content_checks(post_id)
  WHERE changed = TRUE
    AND status = 'changed'
    AND final_content_text IS NOT NULL;
