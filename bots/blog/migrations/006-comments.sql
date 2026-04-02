BEGIN;

CREATE TABLE IF NOT EXISTS blog.comments (
  id SERIAL PRIMARY KEY,
  post_url TEXT NOT NULL,
  post_title TEXT,
  commenter_id TEXT,
  commenter_name TEXT,
  comment_text TEXT NOT NULL,
  comment_ref TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  reply_text TEXT,
  reply_at TIMESTAMPTZ,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  meta JSONB DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_comments_status ON blog.comments(status);
CREATE INDEX IF NOT EXISTS idx_comments_detected ON blog.comments(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_comments_post_url ON blog.comments(post_url);

CREATE TABLE IF NOT EXISTS blog.comment_actions (
  id SERIAL PRIMARY KEY,
  action_type TEXT NOT NULL,
  target_blog TEXT,
  target_post_url TEXT,
  comment_text TEXT,
  success BOOLEAN DEFAULT true,
  executed_at TIMESTAMPTZ DEFAULT NOW(),
  meta JSONB DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_comment_actions_type ON blog.comment_actions(action_type);
CREATE INDEX IF NOT EXISTS idx_comment_actions_target ON blog.comment_actions(target_blog, executed_at DESC);

COMMIT;
