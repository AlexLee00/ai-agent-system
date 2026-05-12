#!/usr/bin/env tsx
// @ts-nocheck
'use strict';
/**
 * 트렌드 수집기 — 매일 06:00 KST 자동 실행
 * 1. Reddit 트렌드 분석 (Python PRAW)
 * 2. 월요일: 알라딘 베스트셀러 수집
 * 3. 결과를 blog.trend_topics 테이블에 저장
 *
 * 실행: npx tsx bots/blog/scripts/run-trend-collector.ts
 */

const path     = require('path');
const { execSync } = require('child_process');
const env      = require('../../../packages/core/lib/env');
const kst      = require('../../../packages/core/lib/kst');
const pgPool   = require('../../../packages/core/lib/pg-pool');

async function ensureTrendTopicsTable() {
  await pgPool.run('blog', `
    CREATE TABLE IF NOT EXISTS blog.trend_topics (
      id          SERIAL PRIMARY KEY,
      date        DATE NOT NULL DEFAULT CURRENT_DATE,
      source      TEXT NOT NULL,            -- 'reddit' | 'bestseller'
      topic_ko    TEXT NOT NULL,
      category    TEXT,
      keywords    JSONB,
      trend_score INTEGER DEFAULT 0,
      korea_relevance INTEGER DEFAULT 0,
      is_book_topic BOOLEAN DEFAULT false,
      used        BOOLEAN DEFAULT false,
      meta        JSONB,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_trend_topics_date ON blog.trend_topics(date);
    CREATE INDEX IF NOT EXISTS idx_trend_topics_used ON blog.trend_topics(used) WHERE used = false;
  `);
}

async function runRedditAnalyzer() {
  const scriptPath = path.join(env.PROJECT_ROOT, 'bots/blog/python/reddit_trend_analyzer.py');
  const outputPath = path.join(env.PROJECT_ROOT, 'bots/blog/output/reddit-trends-latest.json');

  try {
    console.log('[트렌드수집] Reddit 분석기 실행...');
    execSync(`python3 ${scriptPath}`, {
      env: { ...process.env },
      stdio: 'inherit',
      timeout: 120_000,
    });

    // 결과 로드
    const data = JSON.parse(require('fs').readFileSync(outputPath, 'utf8'));
    return data.topics || [];
  } catch (e: any) {
    console.warn('[트렌드수집] Reddit 분석기 실패 (무시):', e.message);
    return [];
  }
}

async function saveTopicsToDb(topics: any[], source: string) {
  if (topics.length === 0) return 0;
  const today = kst.today();
  let inserted = 0;

  for (const t of topics) {
    try {
      const result = await pgPool.run('blog', `
        INSERT INTO blog.trend_topics
          (date, source, topic_ko, category, keywords, trend_score, korea_relevance, is_book_topic, meta)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [
        today,
        source,
        t.topic_ko || t.title,
        t.category || null,
        JSON.stringify(t.keywords || []),
        t.trend_score || 0,
        t.korea_relevance || 0,
        t.is_book_topic || false,
        JSON.stringify({ reason: t.reason, reddit_source: t.reddit_source }),
      ]);
      if (result?.rowCount > 0) inserted++;
    } catch (e: any) {
      console.warn(`[트렌드수집] DB 저장 실패 (${t.topic_ko}):`, e.message);
    }
  }

  return inserted;
}

async function main() {
  console.log(`[트렌드수집] 시작: ${new Date().toISOString()}`);

  await ensureTrendTopicsTable();

  // 1. Reddit 트렌드
  const redditTopics = await runRedditAnalyzer();
  const redditInserted = await saveTopicsToDb(redditTopics, 'reddit');
  console.log(`[트렌드수집] Reddit 토픽 저장: ${redditInserted}개`);

  // 2. 알라딘 베스트셀러 (월요일만)
  const dayOfWeek = new Date().getDay(); // 0=일, 1=월
  if (dayOfWeek === 1) {
    console.log('[트렌드수집] 월요일 — 알라딘 베스트셀러 수집...');
    const { runBestsellerFetch } = require(
      path.join(env.PROJECT_ROOT, 'bots/blog/lib/bestseller-fetcher.ts')
    );
    const result = await runBestsellerFetch();
    console.log(`[트렌드수집] 베스트셀러 큐 추가: ${result.inserted}권`);
  }

  // 3. 오래된 토픽 정리 (30일 이상)
  await pgPool.run('blog', `
    DELETE FROM blog.trend_topics
    WHERE date < CURRENT_DATE - INTERVAL '30 days'
  `).catch(() => {});

  console.log('[트렌드수집] 완료!');
  process.exit(0);
}

main().catch(e => {
  console.error('[트렌드수집] 오류:', e.message);
  process.exit(1);
});
