-- Migration 012: Instagram 크로스포스트 결과 추적
-- Phase D: 인스타 자동 크로스포스팅 안정화

CREATE TABLE IF NOT EXISTS blog.instagram_crosspost (
  id            SERIAL PRIMARY KEY,
  post_id       INT,                         -- blog.posts.id (nullable, 연동 전 기록용)
  post_title    TEXT,
  video_path    TEXT,
  caption       TEXT,
  status        VARCHAR(20) DEFAULT 'pending', -- pending / ok / failed / token_error / skipped
  creation_id   TEXT,                        -- Instagram media container ID
  publish_id    TEXT,                        -- Instagram published media ID
  error_msg     TEXT,
  dry_run       BOOLEAN DEFAULT false,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instagram_crosspost_status_created
  ON blog.instagram_crosspost(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_instagram_crosspost_created
  ON blog.instagram_crosspost(created_at DESC);

-- 주간 리포트용 뷰
CREATE OR REPLACE VIEW blog.instagram_crosspost_weekly AS
SELECT
  COUNT(*)::int                                            AS total,
  COUNT(*) FILTER (WHERE status = 'ok')::int              AS ok_count,
  COUNT(*) FILTER (WHERE status = 'failed')::int          AS fail_count,
  COUNT(*) FILTER (WHERE status = 'token_error')::int     AS token_error_count,
  COUNT(*) FILTER (WHERE status = 'skipped')::int         AS skipped_count,
  ROUND(
    CASE WHEN COUNT(*) FILTER (WHERE status NOT IN ('skipped','pending')) > 0
    THEN COUNT(*) FILTER (WHERE status = 'ok')::numeric
       / NULLIF(COUNT(*) FILTER (WHERE status NOT IN ('skipped','pending')), 0) * 100
    ELSE 0 END, 1
  )                                                        AS success_rate_pct
FROM blog.instagram_crosspost
WHERE created_at >= NOW() - INTERVAL '7 days'
  AND dry_run = false;
