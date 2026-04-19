-- bots/blog/migrations/019-dpo-learning.sql
-- Phase 6: Self-Rewarding DPO + 성공 패턴 라이브러리 + 실패 Taxonomy

-- DPO 선호 쌍 테이블
CREATE TABLE IF NOT EXISTS blog.dpo_preference_pairs (
  id BIGSERIAL PRIMARY KEY,
  post_a_id TEXT NOT NULL,                    -- Preferred (성공 포스팅 ID)
  post_b_id TEXT NOT NULL,                    -- Rejected (실패 포스팅 ID)
  metric_winner CHAR(1) NOT NULL CHECK (metric_winner IN ('a', 'b')),
  metric_type TEXT NOT NULL,                  -- 'engagement' | 'views' | 'revenue_attributed'
  reasoning TEXT,                             -- LLM 분석 결과 JSON
  features JSONB,                             -- { hook_type_a, hook_type_b, category, score_a, score_b, ... }
  inserted_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blog_dpo_metric ON blog.dpo_preference_pairs(metric_type, inserted_at DESC);
CREATE INDEX IF NOT EXISTS idx_blog_dpo_category ON blog.dpo_preference_pairs((features->>'category'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_dpo_pair ON blog.dpo_preference_pairs(post_a_id, post_b_id, metric_type);

-- 성공 패턴 라이브러리
CREATE TABLE IF NOT EXISTS blog.success_pattern_library (
  id BIGSERIAL PRIMARY KEY,
  pattern_type TEXT NOT NULL,                 -- 'hook' | 'title_template' | 'structure' | 'cta'
  pattern_template TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'naver',     -- 'naver' | 'instagram' | 'facebook'
  avg_performance NUMERIC(6,2) DEFAULT 50,    -- 0~100 (높을수록 좋음)
  usage_count INTEGER DEFAULT 0,
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_used_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_success_pattern_unique
  ON blog.success_pattern_library(pattern_type, pattern_template, platform);
CREATE INDEX IF NOT EXISTS idx_blog_success_pattern_perf
  ON blog.success_pattern_library(avg_performance DESC, usage_count DESC);

-- 실패 Taxonomy (실패 패턴 분류 + 회피 힌트)
CREATE TABLE IF NOT EXISTS blog.failure_taxonomy (
  id BIGSERIAL PRIMARY KEY,
  failure_category TEXT NOT NULL UNIQUE,      -- 'poor_hook_list' | 'wrong_timing' | 'off_topic' 등
  example_post_ids TEXT[],
  typical_characteristics JSONB,
  avoidance_hint TEXT,
  frequency_count INTEGER DEFAULT 1,
  last_seen_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blog_failure_freq ON blog.failure_taxonomy(frequency_count DESC);

-- DPO 학습 사이클 이력
CREATE TABLE IF NOT EXISTS blog.dpo_learning_cycles (
  id BIGSERIAL PRIMARY KEY,
  cycle_date DATE NOT NULL DEFAULT CURRENT_DATE,
  period_days INTEGER NOT NULL DEFAULT 30,
  pairs_built INTEGER DEFAULT 0,
  pairs_saved INTEGER DEFAULT 0,
  analyzed_count INTEGER DEFAULT 0,
  transfer_learning JSONB,                    -- cross-platform 이전 결과
  duration_ms INTEGER,
  inserted_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_dpo_cycle_date ON blog.dpo_learning_cycles(cycle_date);
