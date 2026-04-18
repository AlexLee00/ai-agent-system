-- bots/blog/migrations/017-platform-orchestration.sql
-- Phase 4: 멀티 플랫폼 오케스트레이션 + A/B 테스트

-- A/B 테스트 기록
CREATE TABLE IF NOT EXISTS blog.ab_tests (
  id BIGSERIAL PRIMARY KEY,
  test_id TEXT UNIQUE NOT NULL,
  platform TEXT NOT NULL DEFAULT 'naver',

  -- 변형 정의
  variant_a JSONB,
  variant_b JSONB,
  metric_target TEXT DEFAULT 'views',
  hypothesis TEXT,
  sample_size_target INTEGER DEFAULT 100,

  -- 수집 데이터
  variant_a_count INTEGER DEFAULT 0,
  variant_a_score NUMERIC(12,2) DEFAULT 0,
  variant_b_count INTEGER DEFAULT 0,
  variant_b_score NUMERIC(12,2) DEFAULT 0,

  -- 결과
  status TEXT DEFAULT 'running',  -- running | completed | inconclusive
  winner TEXT,                    -- 'a' | 'b' | null
  p_value NUMERIC(6,4),

  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_blog_ab_tests_status ON blog.ab_tests(status);
CREATE INDEX IF NOT EXISTS idx_blog_ab_tests_platform ON blog.ab_tests(platform);

-- 플랫폼 발행 스케줄 (시간대 최적화 결과 저장)
CREATE TABLE IF NOT EXISTS blog.platform_schedules (
  id BIGSERIAL PRIMARY KEY,
  platform TEXT NOT NULL,
  recommended_hours INTEGER[] NOT NULL,
  recommended_weekdays TEXT[],
  confidence NUMERIC(3,2) DEFAULT 0,
  data_points INTEGER DEFAULT 0,
  computed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_schedules_platform
  ON blog.platform_schedules(platform);
