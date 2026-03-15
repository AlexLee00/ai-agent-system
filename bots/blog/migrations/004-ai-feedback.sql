-- 004-ai-feedback.sql
-- 블로그팀 AI proposal feedback 세션/이벤트 레이어

CREATE TABLE IF NOT EXISTS blog.ai_feedback_sessions (
  id                      BIGSERIAL PRIMARY KEY,
  company_id              TEXT,
  user_id                 INTEGER,
  source_type             TEXT NOT NULL,
  source_ref_type         TEXT NOT NULL,
  source_ref_id           TEXT NOT NULL,
  flow_code               TEXT NOT NULL,
  action_code             TEXT NOT NULL,
  proposal_id             TEXT,
  ai_input_text           TEXT,
  ai_input_payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  ai_output_type          TEXT NOT NULL,
  original_snapshot_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  feedback_status         TEXT NOT NULL DEFAULT 'pending',
  accepted_without_edit   BOOLEAN NOT NULL DEFAULT FALSE,
  submitted_snapshot_json JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blog_ai_feedback_sessions_status
  ON blog.ai_feedback_sessions(feedback_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_ai_feedback_sessions_source
  ON blog.ai_feedback_sessions(source_ref_type, source_ref_id, created_at DESC);

CREATE TABLE IF NOT EXISTS blog.ai_feedback_events (
  id                  BIGSERIAL PRIMARY KEY,
  feedback_session_id BIGINT NOT NULL REFERENCES blog.ai_feedback_sessions(id) ON DELETE CASCADE,
  event_type          TEXT NOT NULL,
  field_key           TEXT,
  before_value_json   JSONB,
  after_value_json    JSONB,
  event_meta_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blog_ai_feedback_events_session
  ON blog.ai_feedback_events(feedback_session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_blog_ai_feedback_events_type
  ON blog.ai_feedback_events(event_type, created_at DESC);

ALTER TABLE blog.curriculum_series
  ADD COLUMN IF NOT EXISTS feedback_session_id BIGINT REFERENCES blog.ai_feedback_sessions(id);

CREATE INDEX IF NOT EXISTS idx_blog_curriculum_series_feedback_session
  ON blog.curriculum_series(feedback_session_id);
