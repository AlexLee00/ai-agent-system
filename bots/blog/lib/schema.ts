// @ts-nocheck
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

  _schemaEnsured = true;
}

module.exports = { ensureBlogCoreSchema };
