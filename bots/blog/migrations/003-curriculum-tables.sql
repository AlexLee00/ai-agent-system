-- 003-curriculum-tables.sql
-- curriculum_series 신규 + 기존 curriculum 테이블 확장

-- ── curriculum_series 신규 생성 ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS blog.curriculum_series (
  id              SERIAL PRIMARY KEY,
  series_name     VARCHAR(100) NOT NULL,
  total_lectures  INTEGER      DEFAULT 100,
  status          VARCHAR(20)  DEFAULT 'planned',  -- active | completed | planned | candidate
  start_date      DATE,
  end_date        DATE,
  created_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_curriculum_series_status ON blog.curriculum_series(status);

-- ── 시드: 현재 Node.js 시리즈 ────────────────────────────────────────
INSERT INTO blog.curriculum_series (series_name, total_lectures, status, start_date)
VALUES ('nodejs_120', 120, 'active', '2026-01-01')
ON CONFLICT DO NOTHING;

-- ── 기존 curriculum 테이블 확장 ─────────────────────────────────────
-- series_id FK (기존 series_name과 연결)
ALTER TABLE blog.curriculum
  ADD COLUMN IF NOT EXISTS series_id INTEGER REFERENCES blog.curriculum_series(id);

-- section, keywords 컬럼 추가
ALTER TABLE blog.curriculum
  ADD COLUMN IF NOT EXISTS section  VARCHAR(50);
ALTER TABLE blog.curriculum
  ADD COLUMN IF NOT EXISTS keywords TEXT[];

-- series_id 자동 채우기 (기존 nodejs_120 행)
UPDATE blog.curriculum c
SET series_id = s.id
FROM blog.curriculum_series s
WHERE s.series_name = c.series_name
  AND c.series_id IS NULL;

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_curriculum_series_fk ON blog.curriculum(series_id, lecture_number);
