#!/usr/bin/env tsx
// @ts-nocheck
'use strict';
/**
 * 베스트셀러 동기화 — 매주 월요일 07:00 KST 자동 실행
 * 1. 알라딘 Open API로 베스트셀러 수집 → blog.book_review_queue (도서 리뷰 대기열)
 * 2. blog.trend_topics (source='bestseller') — topic-selector가 토픽 후보로 사용
 *
 * 실행: npx tsx bots/blog/scripts/run-bestseller-sync.ts [--dry-run]
 */

const path   = require('path');
const env    = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool');
const kst    = require('../../../packages/core/lib/kst');

async function saveBooksAsTrendTopics(books, dryRun = false) {
  if (books.length === 0) return 0;
  if (dryRun) {
    console.log('[베스트셀러동기화][dry-run] trend_topics 저장 생략');
    return 0;
  }

  const today = kst.today();
  let inserted = 0;

  for (const book of books) {
    try {
      const result = await pgPool.run('blog', `
        INSERT INTO blog.trend_topics
          (date, source, topic_ko, category, keywords, trend_score, korea_relevance, is_book_topic, meta)
        VALUES ($1, 'bestseller', $2, $3, $4, $5, 85, true, $6)
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [
        today,
        book.title,
        book.category_name_local || '도서',
        JSON.stringify([book.author, book.publisher].filter(Boolean)),
        Math.min(100, Math.round((book.final_score || 0) / 2)),
        JSON.stringify({
          isbn: book.isbn13,
          author: book.author,
          publisher: book.publisher,
          cover_url: book.cover,
          pub_date: book.pubDate,
          rating: book.customerReviewRank,
          sales_point: book.salesPoint,
          added_by: 'bestseller-sync',
        }),
      ]);
      if (result?.rowCount > 0) inserted++;
    } catch (e) {
      console.warn(`[베스트셀러동기화] trend_topics 저장 실패 (${book.title}):`, e.message);
    }
  }

  console.log(`[베스트셀러동기화] trend_topics 저장: ${inserted}권`);
  return inserted;
}

async function main() {
  console.log(`[베스트셀러동기화] 시작: ${new Date().toISOString()}`);

  const dryRun = process.argv.includes('--dry-run');
  const { runBestsellerFetch } = require(
    path.join(env.PROJECT_ROOT, 'bots/blog/lib/bestseller-fetcher.ts')
  );

  const result = await runBestsellerFetch({ dryRun });
  console.log(`[베스트셀러동기화] book_review_queue — 원본:${result.total} 필터:${result.filtered} 추가:${result.inserted}`);

  // trend_topics에도 저장 (topic-selector의 fetchTrendTopicCandidates에서 source='bestseller'로 조회)
  await saveBooksAsTrendTopics(result.books, dryRun);

  process.exit(0);
}

main().catch(e => {
  console.error('[베스트셀러동기화] 오류:', e.message);
  process.exit(1);
});
