-- 026: BLs2 comment learning loop (DDL only; apply requires master gate)

BEGIN;

CREATE TABLE IF NOT EXISTS blog.comment_learning_events (
  id BIGSERIAL PRIMARY KEY,
  comment_id INTEGER,
  source TEXT NOT NULL CHECK (source IN ('own', 'neighbor')),
  type TEXT NOT NULL,
  strategy_version TEXT NOT NULL,
  reply_posted_at TIMESTAMPTZ,
  outcome JSONB NOT NULL DEFAULT '{}'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (comment_id, source, strategy_version)
);

CREATE INDEX IF NOT EXISTS idx_comment_learning_events_source_type
  ON blog.comment_learning_events(source, type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_comment_learning_events_strategy
  ON blog.comment_learning_events(strategy_version, created_at DESC);

CREATE TABLE IF NOT EXISTS blog.comment_strategy_proposals (
  id BIGSERIAL PRIMARY KEY,
  week_key TEXT NOT NULL,
  type TEXT NOT NULL,
  reason TEXT NOT NULL,
  proposal TEXT NOT NULL,
  metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'shadow',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (week_key, type, reason)
);

CREATE INDEX IF NOT EXISTS idx_comment_strategy_proposals_week
  ON blog.comment_strategy_proposals(week_key, status, created_at DESC);

COMMIT;
