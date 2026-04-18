-- bots/blog/migrations/015-revenue-attribution.sql
-- Phase 2: 스카팀 매출 연동 + ROI 추적

-- 포스팅-매출 상관관계 기록
CREATE TABLE IF NOT EXISTS blog.post_revenue_attribution (
  id BIGSERIAL PRIMARY KEY,
  post_id TEXT NOT NULL,
  post_url TEXT,
  post_title TEXT,
  post_platform TEXT NOT NULL,
  post_published_at TIMESTAMPTZ NOT NULL,

  -- 매출 상관관계 (발행 후 7일 기준)
  baseline_revenue_krw NUMERIC(12,2),
  post_period_revenue_krw NUMERIC(12,2),
  uplift_krw NUMERIC(12,2),
  attribution_confidence NUMERIC(3,2) DEFAULT 0.0,
  attribution_method TEXT DEFAULT 'temporal',

  -- 유입 경로 데이터
  utm_visits INTEGER DEFAULT 0,
  referrer_visits INTEGER DEFAULT 0,
  direct_conversion_count INTEGER DEFAULT 0,

  computed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blog_attribution_post ON blog.post_revenue_attribution(post_id);
CREATE INDEX IF NOT EXISTS idx_blog_attribution_date ON blog.post_revenue_attribution(post_published_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_attribution_uplift ON blog.post_revenue_attribution(uplift_krw DESC);

-- 스카팀 예약 테이블 UTM 컬럼 (reservation 스키마 접근 가능할 때만 실행)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'reservation' AND table_name = 'bookings'
  ) THEN
    ALTER TABLE reservation.bookings
      ADD COLUMN IF NOT EXISTS utm_source TEXT,
      ADD COLUMN IF NOT EXISTS utm_medium TEXT,
      ADD COLUMN IF NOT EXISTS utm_campaign TEXT,
      ADD COLUMN IF NOT EXISTS referral_source TEXT;
  END IF;
END$$;

-- ROI 일일 집계 MView
CREATE MATERIALIZED VIEW IF NOT EXISTS blog.roi_daily_summary AS
SELECT
  DATE(post_published_at) AS date,
  post_platform,
  COUNT(*) AS posts_count,
  SUM(uplift_krw) AS total_uplift_krw,
  AVG(attribution_confidence) AS avg_confidence,
  SUM(utm_visits) AS total_utm_visits,
  SUM(direct_conversion_count) AS total_conversions
FROM blog.post_revenue_attribution
WHERE post_published_at > NOW() - INTERVAL '90 days'
GROUP BY DATE(post_published_at), post_platform
ORDER BY date DESC;

CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_roi_daily_date_platform
  ON blog.roi_daily_summary(date, post_platform);

-- 카테고리별 매출 성과 추적 (topic-selector Revenue-Driven 강화용)
CREATE TABLE IF NOT EXISTS blog.category_revenue_performance (
  id BIGSERIAL PRIMARY KEY,
  category TEXT NOT NULL,
  period_days INTEGER NOT NULL DEFAULT 30,
  avg_uplift_krw NUMERIC(12,2),
  post_count INTEGER DEFAULT 0,
  avg_confidence NUMERIC(3,2),
  computed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_cat_revenue_cat_period
  ON blog.category_revenue_performance(category, period_days);
