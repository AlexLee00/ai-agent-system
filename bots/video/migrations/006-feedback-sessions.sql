-- video schema feedback/session tracking for Phase 3.
-- 실제 생성은 ensureVideoFeedbackTables()로도 가능하지만, 명시적 마이그레이션으로 남긴다.

CREATE SCHEMA IF NOT EXISTS video;

CREATE TABLE IF NOT EXISTS video.ai_feedback_sessions (
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

CREATE INDEX IF NOT EXISTS idx_video_ai_feedback_sessions_company_status
  ON video.ai_feedback_sessions(company_id, feedback_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_video_ai_feedback_sessions_source
  ON video.ai_feedback_sessions(source_ref_type, source_ref_id, created_at DESC);

CREATE TABLE IF NOT EXISTS video.ai_feedback_events (
  id                  BIGSERIAL PRIMARY KEY,
  feedback_session_id BIGINT NOT NULL REFERENCES video.ai_feedback_sessions(id) ON DELETE CASCADE,
  event_type          TEXT NOT NULL,
  field_key           TEXT,
  before_value_json   JSONB,
  after_value_json    JSONB,
  event_meta_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_ai_feedback_events_session
  ON video.ai_feedback_events(feedback_session_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_video_ai_feedback_events_type
  ON video.ai_feedback_events(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS video.video_edit_steps (
  id                  BIGSERIAL PRIMARY KEY,
  session_id          INTEGER REFERENCES public.video_sessions(id),
  edit_id             INTEGER REFERENCES public.video_edits(id),
  step_index          INTEGER NOT NULL,
  step_type           TEXT NOT NULL,
  proposal_json       JSONB NOT NULL,
  red_score           INTEGER,
  red_comment         TEXT,
  blue_json           JSONB,
  user_action         TEXT,
  final_json          JSONB,
  feedback_session_id BIGINT REFERENCES video.ai_feedback_sessions(id),
  confidence          REAL,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_edit_steps_session
  ON video.video_edit_steps(session_id, step_index);
CREATE INDEX IF NOT EXISTS idx_video_edit_steps_edit
  ON video.video_edit_steps(edit_id, step_index);
