-- 013-competitor-hashtag.sql
-- Phase 3: 경쟁사 키워드 분석 + 해시태그 트렌드 테이블

-- 경쟁사 키워드 분석 결과
CREATE TABLE IF NOT EXISTS blog.competitor_keywords (
  id              BIGSERIAL PRIMARY KEY,
  category        TEXT        NOT NULL,
  analyzed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  top_keywords    JSONB       NOT NULL DEFAULT '[]',   -- [{ word, count, tfidf, sources }]
  our_keywords    JSONB       NOT NULL DEFAULT '[]',   -- 우리 블로그 키워드
  missing_keywords JSONB      NOT NULL DEFAULT '[]',   -- 갭 키워드
  recommendations  JSONB      NOT NULL DEFAULT '[]',   -- 추천 주제
  raw_json        JSONB       NOT NULL DEFAULT '{}'    -- 전체 리포트
);

CREATE UNIQUE INDEX IF NOT EXISTS competitor_keywords_category_date_idx
  ON blog.competitor_keywords (category, DATE(analyzed_at));

-- 해시태그 트렌드
CREATE TABLE IF NOT EXISTS blog.hashtag_trends (
  id                   BIGSERIAL PRIMARY KEY,
  category             TEXT        NOT NULL,
  analyzed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  top_hashtags         JSONB       NOT NULL DEFAULT '[]',  -- 인기 태그
  niche_hashtags       JSONB       NOT NULL DEFAULT '[]',  -- 틈새 태그
  recommendations_json JSONB       NOT NULL DEFAULT '[]',  -- HashtagScore[]
  strategy             TEXT        NOT NULL DEFAULT ''
);

CREATE UNIQUE INDEX IF NOT EXISTS hashtag_trends_category_date_idx
  ON blog.hashtag_trends (category, DATE(analyzed_at));

COMMENT ON TABLE blog.competitor_keywords IS 'Phase 3: 네이버 블로그 경쟁사 키워드 분석 (주 1회)';
COMMENT ON TABLE blog.hashtag_trends IS 'Phase 3: 인스타 해시태그 트렌드 분석 (주 1회)';
