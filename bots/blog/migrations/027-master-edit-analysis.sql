-- Master-edit analysis is provisioned by migration, never from the runtime process.
CREATE TABLE IF NOT EXISTS blog.master_edit_analysis (
  id SERIAL PRIMARY KEY,
  post_id INTEGER NOT NULL REFERENCES blog.posts(id) ON DELETE CASCADE,
  analyzed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  title_changed BOOLEAN,
  title_sim NUMERIC(4,2),
  added_ratio NUMERIC(4,2),
  removed_ratio NUMERIC(4,2),
  change_rate NUMERIC(4,2),
  primary_type TEXT,
  sub_types TEXT[],
  pattern_summary TEXT,
  preference_rule TEXT,
  raw_diff JSONB
);

CREATE INDEX IF NOT EXISTS idx_master_edit_analysis_post_time
  ON blog.master_edit_analysis(post_id, analyzed_at DESC);
