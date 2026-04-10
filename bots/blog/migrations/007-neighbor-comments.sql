BEGIN;

CREATE TABLE IF NOT EXISTS blog.neighbor_comments (
  id SERIAL PRIMARY KEY,
  target_blog_id TEXT NOT NULL,
  target_blog_name TEXT,
  source_type TEXT NOT NULL,
  source_ref TEXT,
  post_url TEXT NOT NULL,
  post_title TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  comment_text TEXT,
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  meta JSONB DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_neighbor_comments_status ON blog.neighbor_comments(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_neighbor_comments_blog ON blog.neighbor_comments(target_blog_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_neighbor_comments_post_url ON blog.neighbor_comments(post_url);

COMMIT;
