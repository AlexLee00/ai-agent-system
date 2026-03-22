-- 비디오 preview wall-clock 원장 컬럼
-- 실행 예시: psql -d jay -f bots/video/migrations/005-preview-ms.sql

ALTER TABLE video_edits
  ADD COLUMN IF NOT EXISTS preview_ms INTEGER;
