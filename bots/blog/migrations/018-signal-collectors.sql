-- bots/blog/migrations/018-signal-collectors.sql
-- Phase 5: Signal Collector — 트렌드/경쟁사/브랜드 멘션

-- 키워드 트렌드 수집
CREATE TABLE IF NOT EXISTS blog.keyword_trends (
  id BIGSERIAL PRIMARY KEY,
  keyword TEXT NOT NULL,
  trend_score NUMERIC(6,2) DEFAULT 0,
  growth_rate_week NUMERIC(6,2) DEFAULT 0,
  related_keywords TEXT[],
  source TEXT DEFAULT 'naver_datalab',
  collected_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blog_trends_keyword ON blog.keyword_trends(keyword, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_trends_growth ON blog.keyword_trends(growth_rate_week DESC);

-- 브랜드 멘션 수집
CREATE TABLE IF NOT EXISTS blog.brand_mentions (
  id BIGSERIAL PRIMARY KEY,
  keyword TEXT NOT NULL,
  title TEXT,
  description TEXT,
  link TEXT UNIQUE NOT NULL,
  blog_name TEXT,
  post_date TEXT,
  sentiment TEXT NOT NULL DEFAULT 'neutral',  -- positive | neutral | negative
  source TEXT DEFAULT 'naver_blog',
  collected_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blog_mentions_sentiment ON blog.brand_mentions(sentiment, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_mentions_collected ON blog.brand_mentions(collected_at DESC);
