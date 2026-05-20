-- Edu-X 발행 로그 테이블
-- jay DB, public 스키마
-- 적용: psql -U jay -d jay -f migrations/20260520000001_edux_publish_log.sql

CREATE TABLE IF NOT EXISTS edux_publish_log (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  category       TEXT        NOT NULL CHECK (category IN ('crypto', 'kis', 'overseas')),
  schedule_slot  TEXT        NOT NULL CHECK (schedule_slot IN ('0600', '0900', '1400', '2200', '2230')),
  post_id        TEXT,
  post_url       TEXT,
  title          TEXT,
  content_hash   TEXT,
  image_urls     JSONB       DEFAULT '[]'::jsonb,
  status         TEXT        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('success', 'fail', 'skipped', 'dry_run', 'pending')),
  retry_count    INT         NOT NULL DEFAULT 0,
  error_msg      TEXT,
  published_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata       JSONB       DEFAULT '{}'::jsonb
);

-- 최근 발행 중복 방지 (content_hash + category + 하루)
CREATE INDEX IF NOT EXISTS idx_edux_publish_log_content_hash
  ON edux_publish_log (content_hash, category, created_at DESC);

-- 슬롯별 최근 발행 조회 (오늘 이미 발행했는지 확인)
CREATE INDEX IF NOT EXISTS idx_edux_publish_log_slot_date
  ON edux_publish_log (schedule_slot, created_at DESC);

-- 상태별 조회
CREATE INDEX IF NOT EXISTS idx_edux_publish_log_status
  ON edux_publish_log (status, created_at DESC);

COMMENT ON TABLE edux_publish_log IS 'Edu-X 커뮤니티 자동 게시 로그 (bots/edu-x/)';
COMMENT ON COLUMN edux_publish_log.category IS 'crypto / kis / overseas';
COMMENT ON COLUMN edux_publish_log.schedule_slot IS '0600 / 0900 / 1400 / 2200 / 2230 KST';
COMMENT ON COLUMN edux_publish_log.content_hash IS 'SHA256(content) — 중복 발행 방지';
COMMENT ON COLUMN edux_publish_log.image_urls IS '업로드된 이미지 URL 배열';
COMMENT ON COLUMN edux_publish_log.status IS 'success / fail / skipped / dry_run';
COMMENT ON COLUMN edux_publish_log.metadata IS 'LLM 응답, 데이터 소스 요약 등 부가 정보';
