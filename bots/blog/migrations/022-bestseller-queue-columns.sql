-- 베스트셀러 큐 스키마 보완 (bestseller-fetcher.ts 요구사항 맞춤)
-- 1. publisher 컬럼 추가
-- 2. meta 컬럼 추가 (bestseller-fetcher.ts는 meta, 기존 스키마는 metadata)
-- 3. isbn unique partial index → ON CONFLICT (isbn) DO NOTHING 지원
-- 4. trend_topics 테이블 공식 마이그레이션

ALTER TABLE blog.book_review_queue
  ADD COLUMN IF NOT EXISTS publisher TEXT,
  ADD COLUMN IF NOT EXISTS meta JSONB DEFAULT '{}';

-- isbn unique index 생략 (기존 중복 데이터 존재)
-- bestseller-fetcher.ts는 ON CONFLICT DO NOTHING + fetchReviewedIsbns() pre-check로 중복 방지

-- trend_topics: run-trend-collector.ts inline CREATE TABLE의 공식 마이그레이션 버전
CREATE TABLE IF NOT EXISTS blog.trend_topics (
  id              SERIAL PRIMARY KEY,
  date            DATE NOT NULL DEFAULT CURRENT_DATE,
  source          TEXT NOT NULL,           -- 'reddit' | 'bestseller'
  topic_ko        TEXT NOT NULL,
  category        TEXT,
  keywords        JSONB,
  trend_score     INTEGER DEFAULT 0,
  korea_relevance INTEGER DEFAULT 0,
  is_book_topic   BOOLEAN DEFAULT false,
  used            BOOLEAN DEFAULT false,
  meta            JSONB,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trend_topics_date
  ON blog.trend_topics(date);

CREATE INDEX IF NOT EXISTS idx_trend_topics_used
  ON blog.trend_topics(used) WHERE used = false;

CREATE UNIQUE INDEX IF NOT EXISTS idx_trend_topics_uniq
  ON blog.trend_topics(date, source, topic_ko);
