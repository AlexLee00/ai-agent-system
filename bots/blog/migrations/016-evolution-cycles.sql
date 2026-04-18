-- bots/blog/migrations/016-evolution-cycles.sql
-- Phase 3: 자율진화 루프 + Content-Market Fit + AARRR

-- 진화 사이클 이력
CREATE TABLE IF NOT EXISTS blog.evolution_cycles (
  cycle_id TEXT PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  duration_ms INTEGER,
  utilize_stats JSONB,
  collect_stats JSONB,
  analyze_stats JSONB,
  feedback_stats JSONB,
  strategy_changes JSONB,
  content_market_fit_avg NUMERIC(5,2),
  revenue_correlation NUMERIC(4,3),
  inserted_at TIMESTAMPTZ DEFAULT NOW()
);

-- 전략 버전 관리
CREATE TABLE IF NOT EXISTS blog.strategy_versions (
  id BIGSERIAL PRIMARY KEY,
  version TEXT UNIQUE NOT NULL,
  strategy_json JSONB NOT NULL,
  evolved_from_version TEXT,
  reasoning TEXT,
  evolution_cycle_id TEXT REFERENCES blog.evolution_cycles(cycle_id),
  applied_from TIMESTAMPTZ NOT NULL,
  applied_to TIMESTAMPTZ,
  inserted_at TIMESTAMPTZ DEFAULT NOW()
);

-- Content-Market Fit 점수 기록
CREATE TABLE IF NOT EXISTS blog.content_market_fit (
  id BIGSERIAL PRIMARY KEY,
  post_id TEXT NOT NULL,
  post_platform TEXT NOT NULL DEFAULT 'naver',
  measured_at TIMESTAMPTZ DEFAULT NOW(),
  measurement_days INTEGER NOT NULL DEFAULT 14,

  -- 3대 지표
  reach_score NUMERIC(6,2),       -- 도달: 조회수 / 팔로워 * 100
  resonance_score NUMERIC(6,2),   -- 공명: (좋아요+댓글+공유) / 조회수 * 100
  retention_score NUMERIC(6,2),   -- 보유: 이웃 증가율 + 재방문율

  overall_score NUMERIC(6,2),
  grade CHAR(1),                   -- A/B/C/D/F

  -- 원데이터
  views INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  follower_count_at_publish INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_blog_cmf_post ON blog.content_market_fit(post_id);
CREATE INDEX IF NOT EXISTS idx_blog_cmf_score ON blog.content_market_fit(overall_score DESC);

-- AARRR 일일 집계
CREATE TABLE IF NOT EXISTS blog.aarrr_daily (
  id BIGSERIAL PRIMARY KEY,
  date DATE NOT NULL,
  platform TEXT DEFAULT 'all',

  -- Acquisition
  new_visitors INTEGER DEFAULT 0,
  top_channel TEXT,
  cpa_krw NUMERIC(12,2),

  -- Activation
  activation_count INTEGER DEFAULT 0,
  activation_rate NUMERIC(5,4),

  -- Retention
  day7_retention NUMERIC(5,4),
  day30_retention NUMERIC(5,4),

  -- Referral
  referral_count INTEGER DEFAULT 0,
  viral_coefficient NUMERIC(5,3),

  -- Revenue
  total_revenue_krw NUMERIC(12,2),
  arpu_krw NUMERIC(12,2),

  computed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_aarrr_date_platform
  ON blog.aarrr_daily(date, platform);
