-- 002-publish-schedule.sql
-- 일자별 발행 스케줄 테이블

CREATE TABLE IF NOT EXISTS blog.publish_schedule (
  id             SERIAL PRIMARY KEY,
  publish_date   DATE         NOT NULL,
  post_type      VARCHAR(20)  NOT NULL,     -- 'lecture' | 'general'
  lecture_number INTEGER,                   -- 강의 포스팅만 (NULL=자동 결정)
  lecture_title  VARCHAR(200),
  category       VARCHAR(50),               -- 일반 포스팅 카테고리
  book_title     VARCHAR(200),              -- 도서리뷰: 도서명
  book_author    VARCHAR(100),              -- 도서리뷰: 저자
  book_isbn      VARCHAR(20),               -- 도서리뷰: ISBN
  status         VARCHAR(20)  DEFAULT 'scheduled',  -- scheduled | writing | ready | published | archived
  post_id        INTEGER      REFERENCES blog.posts(id),
  created_at     TIMESTAMPTZ  DEFAULT NOW(),
  updated_at     TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE(publish_date, post_type)
);

CREATE INDEX IF NOT EXISTS idx_publish_schedule_date   ON blog.publish_schedule(publish_date);
CREATE INDEX IF NOT EXISTS idx_publish_schedule_status ON blog.publish_schedule(status);

-- ─── 시드 데이터 (2026-03-10 ~ 2026-03-17) ──────────────────────────────
-- 강의 번호는 runtime에 category_rotation에서 채워짐 (lecture_number=NULL)
INSERT INTO blog.publish_schedule (publish_date, post_type, category, status) VALUES
  ('2026-03-10', 'lecture', 'Node.js강의',       'scheduled'),
  ('2026-03-10', 'general', '자기계발',           'scheduled'),
  ('2026-03-11', 'lecture', 'Node.js강의',        'scheduled'),
  ('2026-03-11', 'general', '도서리뷰',           'scheduled'),
  ('2026-03-12', 'lecture', 'Node.js강의',        'scheduled'),
  ('2026-03-12', 'general', '성장과성공',          'scheduled'),
  ('2026-03-13', 'lecture', 'Node.js강의',        'scheduled'),
  ('2026-03-13', 'general', '홈페이지와App',       'scheduled'),
  ('2026-03-14', 'lecture', 'Node.js강의',        'scheduled'),
  ('2026-03-14', 'general', '최신IT트렌드',        'scheduled'),
  ('2026-03-15', 'lecture', 'Node.js강의',        'scheduled'),
  ('2026-03-15', 'general', 'IT정보와분석',        'scheduled'),
  ('2026-03-16', 'lecture', 'Node.js강의',        'scheduled'),
  ('2026-03-16', 'general', '개발기획과컨설팅',    'scheduled'),
  ('2026-03-17', 'lecture', 'Node.js강의',        'scheduled'),
  ('2026-03-17', 'general', '자기계발',            'scheduled')
ON CONFLICT DO NOTHING;
