-- 009: 마스터 피드백 기록
CREATE TABLE IF NOT EXISTS blog.master_feedback (
  id SERIAL PRIMARY KEY,
  post_id INTEGER REFERENCES blog.posts(id),
  original_title TEXT,
  modified_title TEXT,
  original_content_hash TEXT,
  modified_content_hash TEXT,
  diff_summary TEXT,
  feedback_type VARCHAR(20),
  learned_at TIMESTAMP DEFAULT NOW()
);

-- 010: 자율 Phase 추적
CREATE TABLE IF NOT EXISTS blog.autonomy_log (
  id SERIAL PRIMARY KEY,
  week_of DATE,
  total_posts INTEGER DEFAULT 0,
  auto_published INTEGER DEFAULT 0,
  master_reviewed INTEGER DEFAULT 0,
  master_modified INTEGER DEFAULT 0,
  accuracy FLOAT DEFAULT 0,
  current_phase INTEGER DEFAULT 1,
  phase_changed BOOLEAN DEFAULT FALSE,
  logged_at TIMESTAMP DEFAULT NOW()
);

-- 011: 매출 상관 분석 캐시
CREATE TABLE IF NOT EXISTS blog.revenue_correlation (
  id SERIAL PRIMARY KEY,
  period_days INTEGER,
  active_avg_revenue FLOAT,
  inactive_avg_revenue FLOAT,
  revenue_impact FLOAT,
  revenue_impact_pct FLOAT,
  high_view_revenue_after FLOAT,
  analyzed_at TIMESTAMP DEFAULT NOW()
);
