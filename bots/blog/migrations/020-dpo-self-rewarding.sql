-- bots/blog/migrations/020-dpo-self-rewarding.sql
-- Phase 6: Self-Rewarding DPO + 성공 패턴 라이브러리 + 실패 Taxonomy

-- DPO 선호 쌍 (성공 vs 실패 포스팅 매칭)
CREATE TABLE IF NOT EXISTS blog.dpo_preference_pairs (
  id BIGSERIAL PRIMARY KEY,
  post_a_id TEXT NOT NULL,            -- Preferred (성공)
  post_b_id TEXT NOT NULL,            -- Rejected (실패)
  metric_winner CHAR(1) NOT NULL,     -- 'a' | 'b'
  metric_type TEXT NOT NULL,          -- 'views' | 'engagement' | 'revenue_attributed'
  reasoning TEXT,                     -- LLM 분석 결과
  features JSONB,                     -- 제목/길이/카테고리 등 특성 비교
  category TEXT,
  score_a NUMERIC(6,2),
  score_b NUMERIC(6,2),
  inserted_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blog_dpo_metric
  ON blog.dpo_preference_pairs(metric_type, inserted_at DESC);

CREATE INDEX IF NOT EXISTS idx_blog_dpo_category
  ON blog.dpo_preference_pairs(category, inserted_at DESC);

-- 성공 패턴 라이브러리
CREATE TABLE IF NOT EXISTS blog.success_pattern_library (
  id BIGSERIAL PRIMARY KEY,
  pattern_type TEXT NOT NULL,         -- 'hook' | 'title' | 'structure' | 'cta' | 'timing'
  pattern_template TEXT,
  platform TEXT,                      -- 'naver' | 'instagram' | 'facebook' | null (전체)
  category TEXT,
  avg_performance NUMERIC(6,2) DEFAULT 0,
  usage_count INTEGER DEFAULT 0,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  active BOOLEAN DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_blog_patterns_type
  ON blog.success_pattern_library(pattern_type, avg_performance DESC);

CREATE INDEX IF NOT EXISTS idx_blog_patterns_platform
  ON blog.success_pattern_library(platform, active);

-- 실패 Taxonomy (반복 실패 패턴 분류)
CREATE TABLE IF NOT EXISTS blog.failure_taxonomy (
  id BIGSERIAL PRIMARY KEY,
  failure_category TEXT NOT NULL,     -- 'wrong_timing' | 'poor_hook' | 'off_topic' | 'low_quality' | 'format_mismatch'
  example_post_ids TEXT[],
  typical_characteristics JSONB,
  avoidance_hint TEXT,
  platform TEXT,
  frequency_count INTEGER DEFAULT 1,
  last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blog_failure_category
  ON blog.failure_taxonomy(failure_category, frequency_count DESC);

-- UNIQUE 제약: failure_taxonomy ON CONFLICT 지원
CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_failure_taxonomy_uq
  ON blog.failure_taxonomy(failure_category);

-- UNIQUE 제약: success_pattern_library ON CONFLICT 지원
CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_patterns_uq
  ON blog.success_pattern_library(pattern_type, COALESCE(pattern_template, ''), COALESCE(platform, ''));

-- Cross-Platform Transfer 기록
CREATE TABLE IF NOT EXISTS blog.cross_platform_transfers (
  id BIGSERIAL PRIMARY KEY,
  learned_from TEXT NOT NULL,         -- 'instagram' | 'naver' | 'facebook'
  applied_to TEXT[] NOT NULL,
  pattern_type TEXT,
  template_count INTEGER DEFAULT 0,
  confidence NUMERIC(4,3) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- DPO 학습 사이클 이력
CREATE TABLE IF NOT EXISTS blog.dpo_learning_cycles (
  cycle_date DATE PRIMARY KEY,
  period_days INTEGER DEFAULT 30,
  pairs_built INTEGER DEFAULT 0,
  pairs_saved INTEGER DEFAULT 0,
  analyzed_count INTEGER DEFAULT 0,
  transfer_learning JSONB,
  duration_ms INTEGER,
  inserted_at TIMESTAMPTZ DEFAULT NOW()
);
