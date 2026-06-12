-- CODEX-B2b: collect final Naver content diffs without polluting unchanged posts.
-- Apply manually before enabling write mode:
--   psql -d jay -f bots/blog/migrations/024-final-content-diff.sql

CREATE SCHEMA IF NOT EXISTS blog;

CREATE TABLE IF NOT EXISTS blog.master_feedback (
  id SERIAL PRIMARY KEY,
  post_id INTEGER REFERENCES blog.posts(id),
  original_title TEXT,
  modified_title TEXT,
  original_content_hash TEXT,
  modified_content_hash TEXT,
  diff_summary TEXT,
  feedback_type VARCHAR(20),
  learned_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE blog.master_feedback
  ADD COLUMN IF NOT EXISTS original_title TEXT,
  ADD COLUMN IF NOT EXISTS modified_title TEXT,
  ADD COLUMN IF NOT EXISTS original_content_hash TEXT,
  ADD COLUMN IF NOT EXISTS modified_content_hash TEXT,
  ADD COLUMN IF NOT EXISTS diff_summary TEXT,
  ADD COLUMN IF NOT EXISTS feedback_type VARCHAR(20),
  ADD COLUMN IF NOT EXISTS learned_at TIMESTAMP DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_master_feedback_post_id
  ON blog.master_feedback(post_id);

CREATE INDEX IF NOT EXISTS idx_master_feedback_learned_at
  ON blog.master_feedback(learned_at DESC);

CREATE TABLE IF NOT EXISTS blog.final_content_checks (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES blog.posts(id) ON DELETE CASCADE,
  naver_url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  changed BOOLEAN,
  original_content_hash TEXT,
  final_content_hash TEXT,
  diff_summary TEXT,
  vault_file_path TEXT,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE(post_id),
  CONSTRAINT final_content_checks_status_check CHECK (
    status IN (
      'pending',
      'changed',
      'unchanged',
      'fetch_failed',
      'skipped_empty_original',
      'feedback_failed',
      'vault_failed'
    )
  )
);

ALTER TABLE blog.final_content_checks
  ADD COLUMN IF NOT EXISTS naver_url TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS changed BOOLEAN,
  ADD COLUMN IF NOT EXISTS original_content_hash TEXT,
  ADD COLUMN IF NOT EXISTS final_content_hash TEXT,
  ADD COLUMN IF NOT EXISTS diff_summary TEXT,
  ADD COLUMN IF NOT EXISTS vault_file_path TEXT,
  ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS idx_final_content_checks_post_id_unique
  ON blog.final_content_checks(post_id);

CREATE INDEX IF NOT EXISTS idx_final_content_checks_checked_at
  ON blog.final_content_checks(checked_at DESC);

CREATE INDEX IF NOT EXISTS idx_final_content_checks_status
  ON blog.final_content_checks(status);
