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
