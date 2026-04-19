-- bots/blog/migrations/019-publish-log.sql
-- Phase 1: 3 플랫폼 통합 발행 로그

CREATE TABLE IF NOT EXISTS blog.publish_log (
  id BIGSERIAL PRIMARY KEY,
  platform TEXT NOT NULL,             -- 'naver' | 'instagram' | 'facebook'
  status TEXT NOT NULL,               -- 'success' | 'failed'
  title TEXT NOT NULL,
  url TEXT,
  post_id TEXT,
  error TEXT,
  duration_ms INTEGER,
  dry_run BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blog_publish_log_platform
  ON blog.publish_log(platform, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_blog_publish_log_status
  ON blog.publish_log(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_blog_publish_log_date
  ON blog.publish_log(created_at DESC);
