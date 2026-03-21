-- video_sessions.company_id를 worker 회사 ID 체계(TEXT)와 일치시키는 보정 마이그레이션
-- 실행 예시: psql -d jay -f bots/video/migrations/003-video-sessions-company-text.sql

ALTER TABLE IF EXISTS public.video_sessions
  ALTER COLUMN company_id TYPE TEXT
  USING company_id::TEXT;
