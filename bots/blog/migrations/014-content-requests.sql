-- 014-content-requests.sql
-- 루나→블로 크로스팀 콘텐츠 요청 테이블

CREATE TABLE IF NOT EXISTS blog.content_requests (
  id                SERIAL PRIMARY KEY,
  source_team       VARCHAR(30)  NOT NULL DEFAULT 'luna',
  regime            VARCHAR(20),                           -- 'bull' | 'bear' | 'volatile' | 'crisis'
  mood              VARCHAR(50),                           -- '상승장' | '하락장' | '변동성 확대' | ...
  angle_hint        TEXT,                                  -- 합성 주제 앵글 힌트
  keyword_hints     TEXT,                                  -- 키워드 힌트 (콤마 구분)
  urgency           SMALLINT     NOT NULL DEFAULT 5,       -- 1(낮음)~10(높음)
  status            VARCHAR(20)  NOT NULL DEFAULT 'pending', -- 'pending' | 'fulfilled' | 'expired' | 'failed'
  fulfilled_post_id INTEGER,                               -- blog.posts.id (외래키 없음, 유연성 보장)
  requested_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  fulfilled_at      TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  metadata          JSONB        NOT NULL DEFAULT '{}'::JSONB
);

CREATE INDEX IF NOT EXISTS idx_content_requests_status_urgency
  ON blog.content_requests(status, urgency DESC, requested_at ASC);

CREATE INDEX IF NOT EXISTS idx_content_requests_requested_at
  ON blog.content_requests(requested_at DESC);

COMMENT ON TABLE blog.content_requests IS '크로스팀 콘텐츠 요청 (루나→블로 투자 앵글 등), 014 마이그레이션';
