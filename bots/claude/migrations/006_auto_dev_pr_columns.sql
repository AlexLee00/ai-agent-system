-- Migration: 006_auto_dev_pr_columns.sql
-- Claude auto-dev 결과에 PR shadow artifact 링크를 보존한다.

ALTER TABLE claude.auto_dev_outcomes
  ADD COLUMN IF NOT EXISTS pr_number INTEGER;

ALTER TABLE claude.auto_dev_outcomes
  ADD COLUMN IF NOT EXISTS pr_url TEXT;

CREATE INDEX IF NOT EXISTS idx_claude_auto_dev_outcomes_pr_number
  ON claude.auto_dev_outcomes (pr_number)
  WHERE pr_number IS NOT NULL;
