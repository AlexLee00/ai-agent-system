'use strict';

const pgPool = require('../../../packages/core/lib/pg-pool');

let _schemaEnsured = false;

async function ensureBlogCoreSchema() {
  if (_schemaEnsured) return;

  await pgPool.run('blog', 'CREATE SCHEMA IF NOT EXISTS blog');

  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS blog.posts (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      post_type TEXT NOT NULL DEFAULT 'general',
      lecture_number INTEGER,
      series_name TEXT DEFAULT 'nodejs_120',
      publish_date DATE NOT NULL DEFAULT CURRENT_DATE,
      status TEXT DEFAULT 'draft',
      char_count INTEGER,
      content TEXT,
      html_content TEXT,
      hashtags TEXT[] DEFAULT '{}',
      image_urls TEXT[] DEFAULT '{}',
      naver_url TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS blog.daily_config (
      id SERIAL PRIMARY KEY,
      lecture_count INTEGER DEFAULT 1,
      general_count INTEGER DEFAULT 1,
      max_total INTEGER DEFAULT 4,
      active BOOLEAN DEFAULT true,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS blog.category_rotation (
      id SERIAL PRIMARY KEY,
      rotation_type TEXT NOT NULL,
      current_index INTEGER NOT NULL DEFAULT 0,
      series_name TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS blog.curriculum (
      id SERIAL PRIMARY KEY,
      series_name TEXT NOT NULL,
      lecture_number INTEGER NOT NULL,
      title TEXT NOT NULL,
      month_chapter INTEGER,
      difficulty TEXT DEFAULT 'intermediate',
      status TEXT DEFAULT 'pending',
      published_post_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(series_name, lecture_number)
    )
  `);

  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS blog.publish_schedule (
      id SERIAL PRIMARY KEY,
      publish_date DATE NOT NULL,
      post_type VARCHAR(20) NOT NULL,
      lecture_number INTEGER,
      lecture_title VARCHAR(200),
      category VARCHAR(50),
      book_title VARCHAR(200),
      book_author VARCHAR(100),
      book_isbn VARCHAR(20),
      status VARCHAR(20) DEFAULT 'scheduled',
      post_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(publish_date, post_type)
    )
  `);

  await pgPool.run('blog', `
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
    )
  `);

  await pgPool.run('blog', `
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
    )
  `);

  await pgPool.run('blog', `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_book_catalog_isbn_unique
    ON blog.book_catalog (isbn)
    WHERE isbn IS NOT NULL AND isbn <> ''
  `);

  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_book_catalog_priority
    ON blog.book_catalog (priority DESC, added_at DESC)
  `);

  await pgPool.run('blog', `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_book_review_queue_daily_unique
    ON blog.book_review_queue (queue_date, title, author)
  `);

  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_book_review_queue_status
    ON blog.book_review_queue (status, queue_date DESC, priority DESC)
  `);

  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS blog.topic_candidates (
      id SERIAL PRIMARY KEY,
      category VARCHAR(50) NOT NULL,
      title TEXT NOT NULL,
      question TEXT,
      diff TEXT,
      keywords TEXT[] DEFAULT '{}',
      source_issues JSONB DEFAULT '[]',
      score FLOAT DEFAULT 0.5,
      status VARCHAR(20) DEFAULT 'pending',
      target_date DATE NOT NULL,
      selected_at TIMESTAMP,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_topic_candidates_date
    ON blog.topic_candidates (target_date)
  `);

  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_topic_candidates_status
    ON blog.topic_candidates (status)
  `);

  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS blog.topic_queue (
      id SERIAL PRIMARY KEY,
      category VARCHAR(50) NOT NULL,
      title TEXT NOT NULL,
      question TEXT,
      diff TEXT,
      reader_problem TEXT,
      opening_angle TEXT,
      key_questions TEXT[],
      closing_angle TEXT,
      trend_source TEXT,
      trend_summary TEXT,
      quality_score FLOAT DEFAULT 0,
      duplicate_check BOOLEAN DEFAULT FALSE,
      status VARCHAR(20) DEFAULT 'pending',
      scheduled_date DATE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      consumed_at TIMESTAMPTZ
    )
  `);

  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_topic_queue_date_status
    ON blog.topic_queue (scheduled_date, status)
  `);

  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS blog.autonomy_decisions (
      id SERIAL PRIMARY KEY,
      decision_date DATE NOT NULL DEFAULT CURRENT_DATE,
      post_type TEXT NOT NULL,
      category TEXT,
      title TEXT NOT NULL,
      post_id INTEGER,
      autonomy_phase INTEGER DEFAULT 1,
      decision TEXT NOT NULL DEFAULT 'master_review',
      score NUMERIC DEFAULT 0,
      threshold NUMERIC DEFAULT 0,
      reasons JSONB DEFAULT '[]',
      sense_summary JSONB DEFAULT '{}',
      revenue_summary JSONB DEFAULT '{}',
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_autonomy_decisions_date
    ON blog.autonomy_decisions (decision_date DESC, post_type)
  `);

  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_autonomy_decisions_decision
    ON blog.autonomy_decisions (decision, created_at DESC)
  `);

  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS blog.channel_performance (
      id SERIAL PRIMARY KEY,
      snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
      channel TEXT NOT NULL,
      source TEXT DEFAULT 'local',
      status TEXT DEFAULT 'ok',
      published_count INTEGER DEFAULT 0,
      views INTEGER DEFAULT 0,
      comments INTEGER DEFAULT 0,
      likes INTEGER DEFAULT 0,
      engagement_rate NUMERIC DEFAULT 0,
      revenue_signal NUMERIC DEFAULT 0,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(snapshot_date, channel, source)
    )
  `);

  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_channel_performance_date
    ON blog.channel_performance (snapshot_date DESC, channel)
  `);

  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS blog.publish_log (
      id BIGSERIAL PRIMARY KEY,
      platform TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT,
      post_id TEXT,
      error TEXT,
      duration_ms INTEGER,
      dry_run BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_blog_publish_log_platform
    ON blog.publish_log(platform, created_at DESC)
  `);

  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_blog_publish_log_status
    ON blog.publish_log(status, created_at DESC)
  `);

  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_blog_publish_log_date
    ON blog.publish_log(created_at DESC)
  `);

  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_publish_schedule_date
    ON blog.publish_schedule(publish_date)
  `);

  await pgPool.run('blog', `
    CREATE INDEX IF NOT EXISTS idx_publish_schedule_status
    ON blog.publish_schedule(status)
  `);

  await pgPool.run('blog', `
    INSERT INTO blog.daily_config (lecture_count, general_count, max_total, active)
    SELECT 1, 1, 4, true
    WHERE NOT EXISTS (SELECT 1 FROM blog.daily_config)
  `);

  await pgPool.run('blog', `
    INSERT INTO blog.category_rotation (rotation_type, current_index, series_name)
    SELECT 'general_category', 2, NULL
    WHERE NOT EXISTS (
      SELECT 1 FROM blog.category_rotation WHERE rotation_type = 'general_category'
    )
  `);

  await pgPool.run('blog', `
    INSERT INTO blog.category_rotation (rotation_type, current_index, series_name)
    SELECT 'lecture_series', 32, 'nodejs_120'
    WHERE NOT EXISTS (
      SELECT 1 FROM blog.category_rotation WHERE rotation_type = 'lecture_series'
    )
  `);

  await pgPool.run('blog', `
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
    ON CONFLICT DO NOTHING
  `);

  _schemaEnsured = true;
}

module.exports = { ensureBlogCoreSchema };
