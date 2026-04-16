-- 010: D-1 주제 후보 큐레이션 테이블
-- CODEX_BLOG_OPS_HARDENING Phase B Step 6

CREATE TABLE IF NOT EXISTS blog.topic_candidates (
  id              SERIAL PRIMARY KEY,
  category        VARCHAR(50)   NOT NULL,
  title           TEXT          NOT NULL,
  question        TEXT,
  diff            TEXT,
  keywords        TEXT[]        DEFAULT '{}',
  source_issues   JSONB         DEFAULT '[]',
  score           FLOAT         DEFAULT 0.5,
  status          VARCHAR(20)   DEFAULT 'pending',
  target_date     DATE          NOT NULL,
  selected_at     TIMESTAMP,
  created_at      TIMESTAMP     DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_candidates_date   ON blog.topic_candidates (target_date);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON blog.topic_candidates (status);

-- 010: 토큰 갱신 이벤트 로그
CREATE TABLE IF NOT EXISTS blog.token_renewal_log (
  id            SERIAL PRIMARY KEY,
  provider      VARCHAR(30)  NOT NULL DEFAULT 'instagram',
  result        VARCHAR(20)  NOT NULL,   -- success / failed / skipped
  days_left     INTEGER,
  new_expires_at TIMESTAMP,
  error_message TEXT,
  renewed_at    TIMESTAMP    DEFAULT NOW()
);
