-- 비디오팀 DB 스키마
-- 실행: psql -d jay -f 001-video-schema.sql

CREATE TABLE IF NOT EXISTS video_edits (
  id                 SERIAL PRIMARY KEY,

  -- 소스
  source_dir         TEXT NOT NULL,
  title              TEXT,

  -- 원본 정보
  raw_video_path     TEXT,
  raw_audio_path     TEXT,
  raw_duration_ms    INTEGER,

  -- STT
  srt_raw_path       TEXT,
  srt_corrected_path TEXT,
  whisper_cost       NUMERIC(10,4),
  correction_cost    NUMERIC(10,4),

  -- CapCut
  draft_path         TEXT,
  draft_version      INTEGER DEFAULT 1,

  -- 렌더링
  output_path        TEXT,
  output_size_mb     NUMERIC(10,2),
  output_duration_ms INTEGER,

  -- 품질
  quality_score      INTEGER,
  quality_loops      INTEGER DEFAULT 0,

  -- 처리 시간
  preprocess_ms      INTEGER,
  stt_ms             INTEGER,
  correction_ms      INTEGER,
  draft_ms           INTEGER,
  render_ms          INTEGER,
  total_ms           INTEGER,

  -- 상태
  status             TEXT DEFAULT 'pending',
  error_message      TEXT,
  trace_id           TEXT,

  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_video_edits_status ON video_edits(status);
CREATE INDEX idx_video_edits_created ON video_edits(created_at DESC);
