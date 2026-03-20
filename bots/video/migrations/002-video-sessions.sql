-- 비디오 세션/업로드 관리 스키마
-- 실행 예시: psql -d jay -f bots/video/migrations/002-video-sessions.sql

CREATE TABLE IF NOT EXISTS video_sessions (
  id                SERIAL PRIMARY KEY,
  company_id        INTEGER NOT NULL,
  uploaded_by       INTEGER NOT NULL,
  title             TEXT,
  edit_notes        TEXT,
  status            TEXT DEFAULT 'idle',
  estimated_time_ms INTEGER,
  total_cost        NUMERIC(10,4) DEFAULT 0,
  file_count        INTEGER DEFAULT 0,
  total_size_mb     NUMERIC(10,2) DEFAULT 0,
  error_message     TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS video_upload_files (
  id              SERIAL PRIMARY KEY,
  session_id      INTEGER NOT NULL REFERENCES video_sessions(id),
  file_type       TEXT NOT NULL,
  original_name   TEXT NOT NULL,
  stored_name     TEXT NOT NULL,
  stored_path     TEXT NOT NULL,
  file_size_mb    NUMERIC(10,2),
  duration_ms     INTEGER,
  sort_order      INTEGER NOT NULL,
  pair_index      INTEGER,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE video_edits ADD COLUMN IF NOT EXISTS session_id INTEGER REFERENCES video_sessions(id);
ALTER TABLE video_edits ADD COLUMN IF NOT EXISTS pair_index INTEGER;
ALTER TABLE video_edits ADD COLUMN IF NOT EXISTS confirm_status TEXT DEFAULT 'pending';
ALTER TABLE video_edits ADD COLUMN IF NOT EXISTS reject_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_video_sessions_company ON video_sessions(company_id);
CREATE INDEX IF NOT EXISTS idx_video_sessions_status ON video_sessions(status);
CREATE INDEX IF NOT EXISTS idx_video_upload_files_session ON video_upload_files(session_id);
CREATE INDEX IF NOT EXISTS idx_video_edits_session ON video_edits(session_id);
