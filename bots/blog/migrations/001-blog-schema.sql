-- 블로그팀 PostgreSQL 스키마
-- 실행: psql -U <user> -d jay -f bots/blog/migrations/001-blog-schema.sql

CREATE SCHEMA IF NOT EXISTS blog;

-- 블로그 포스팅 이력
CREATE TABLE IF NOT EXISTS blog.posts (
  id             SERIAL PRIMARY KEY,
  title          TEXT    NOT NULL,
  category       TEXT    NOT NULL,
  post_type      TEXT    NOT NULL,          -- 'lecture' | 'general'
  lecture_number INTEGER,
  series_name    TEXT    DEFAULT 'nodejs_120',
  publish_date   DATE    NOT NULL,
  status         TEXT    DEFAULT 'draft',   -- 'draft' | 'ready' | 'published' | 'failed'
  char_count     INTEGER,
  content        TEXT,
  html_content   TEXT,                      -- 네이버 블로그용 HTML
  hashtags       TEXT[]  DEFAULT '{}',
  image_urls     TEXT[]  DEFAULT '{}',
  naver_url      TEXT,
  metadata       JSONB   DEFAULT '{}',
  created_at     TIMESTAMPTZ DEFAULT NOW()
);

-- 카테고리 순환 추적
CREATE TABLE IF NOT EXISTS blog.category_rotation (
  id             SERIAL PRIMARY KEY,
  rotation_type  TEXT    NOT NULL,          -- 'general_category' | 'lecture_series'
  current_index  INTEGER NOT NULL DEFAULT 0,
  series_name    TEXT,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- 커리큘럼 관리
CREATE TABLE IF NOT EXISTS blog.curriculum (
  id              SERIAL PRIMARY KEY,
  series_name     TEXT    NOT NULL,         -- 'nodejs_120', 'python_100' 등
  lecture_number  INTEGER NOT NULL,
  title           TEXT    NOT NULL,
  month_chapter   INTEGER,                  -- 1~4
  difficulty      TEXT    DEFAULT 'intermediate',
  status          TEXT    DEFAULT 'pending',-- 'pending' | 'published' | 'skipped'
  published_post_id INTEGER REFERENCES blog.posts(id),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(series_name, lecture_number)
);

-- 수집 데이터 캐시
CREATE TABLE IF NOT EXISTS blog.research_cache (
  id         SERIAL PRIMARY KEY,
  date       DATE    NOT NULL,
  category   TEXT,
  data       JSONB   NOT NULL,
  source     TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 일일 설정
CREATE TABLE IF NOT EXISTS blog.daily_config (
  id             SERIAL PRIMARY KEY,
  lecture_count  INTEGER DEFAULT 1,
  general_count  INTEGER DEFAULT 1,
  max_total      INTEGER DEFAULT 4,
  active         BOOLEAN DEFAULT true,
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS blog.book_catalog (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  isbn VARCHAR(13),
  category VARCHAR(50) DEFAULT 'IT',
  priority INTEGER DEFAULT 50,
  reviewed BOOLEAN DEFAULT FALSE,
  reviewed_date DATE,
  source VARCHAR(30) DEFAULT 'manual',
  metadata JSONB DEFAULT '{}',
  added_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_book_catalog_isbn_unique
ON blog.book_catalog (isbn)
WHERE isbn IS NOT NULL AND isbn <> '';

CREATE INDEX IF NOT EXISTS idx_book_catalog_priority
ON blog.book_catalog (priority DESC, added_at DESC);

CREATE TABLE IF NOT EXISTS blog.book_review_queue (
  id SERIAL PRIMARY KEY,
  queue_date DATE NOT NULL DEFAULT CURRENT_DATE,
  title TEXT NOT NULL,
  author TEXT NOT NULL,
  isbn VARCHAR(13),
  category VARCHAR(50) DEFAULT '기타',
  priority INTEGER DEFAULT 50,
  status VARCHAR(20) DEFAULT 'queued',
  source VARCHAR(30) DEFAULT 'catalog',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_book_review_queue_daily_unique
ON blog.book_review_queue (queue_date, title, author);

CREATE INDEX IF NOT EXISTS idx_book_review_queue_status
ON blog.book_review_queue (status, queue_date DESC, priority DESC);

-- 초기 설정 삽입
INSERT INTO blog.daily_config (lecture_count, general_count)
VALUES (1, 1)
ON CONFLICT DO NOTHING;

-- 카테고리 순환 초기값
INSERT INTO blog.category_rotation (rotation_type, current_index, series_name)
VALUES
  ('general_category', 2, NULL),          -- 현재: 성장과성공 (index 2)
  ('lecture_series',  32, 'nodejs_120')   -- 현재까지 32강 완료, 다음: 33강
ON CONFLICT DO NOTHING;

INSERT INTO blog.book_catalog (title, author, isbn, category, priority, source)
VALUES
  ('소프트웨어 장인', '산드로 만쿠소', '9788968482397', 'IT', 100, 'canonical'),
  ('클린 코드', '로버트 마틴', '9788966260959', 'IT', 100, 'canonical'),
  ('클린 아키텍처', '로버트 마틴', '9788966262472', 'IT', 100, 'canonical'),
  ('함께 자라기', '김창준', '9788966262335', '자기계발', 100, 'canonical'),
  ('피닉스 프로젝트', '진 킴', '9788966261437', 'IT', 100, 'canonical'),
  ('데브옵스 핸드북', '진 킴', '9788966261857', 'IT', 100, 'canonical'),
  ('아토믹 해빗', '제임스 클리어', '9788966262588', '자기계발', 100, 'canonical'),
  ('원씽', '게리 켈러', '9788901153667', '자기계발', 100, 'canonical')
ON CONFLICT DO NOTHING;
