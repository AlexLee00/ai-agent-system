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
const {
  ensureBlogV3Tables,
  saveTrendTopics,
} = require(path.join(env.PROJECT_ROOT, 'bots/blog/lib/blog-v3-unified.ts'));

async function ensureTrendTopicsTable() {
  await ensureBlogV3Tables();
}

async function saveBooksAsTrendTopics(books, dryRun = false) {
  const topics = (books || []).map((book) => ({
    topic_ko: book.title,
    category: book.category_name_local || '도서',
    keywords: [book.author, book.publisher].filter(Boolean),
    trend_score: Math.min(100, Math.round((book.final_score || 0) / 2)),
    korea_relevance: 85,
    is_book_topic: true,
    reason: 'Aladin bestseller 기반 V3 후보',
    meta: {
      isbn: book.isbn13,
      author: book.author,
      publisher: book.publisher,
      cover_url: book.cover,
      pub_date: book.pubDate,
      rating: book.customerReviewRank,
      sales_point: book.salesPoint,
    },
  }));
  const saved = await saveTrendTopics(topics, 'bestseller', { dryRun, addedBy: 'bestseller-sync' });
  if (dryRun) console.log('[베스트셀러동기화][dry-run] trend_topics 저장 생략');
  console.log(`[베스트셀러동기화] trend_topics ${dryRun ? '후보' : '저장'}: ${saved.candidates}/${saved.inserted}`);
  return saved;
}

async function main() {
  console.log(`[베스트셀러동기화] 시작: ${new Date().toISOString()}`);

  const dryRun = process.argv.includes('--dry-run');
  const json = process.argv.includes('--json');
  const { runBestsellerFetch } = require(
    path.join(env.PROJECT_ROOT, 'bots/blog/lib/bestseller-fetcher.ts')
  );

  const result = await runBestsellerFetch({ dryRun });
  console.log(`[베스트셀러동기화] book_review_queue — 원본:${result.total} 필터:${result.filtered} 추가:${result.inserted}`);

  // trend_topics에도 저장 (topic-selector의 fetchTrendTopicCandidates에서 source='bestseller'로 조회)
  if (!dryRun) {
    await ensureTrendTopicsTable();
  }
  const trend = await saveBooksAsTrendTopics(result.books, dryRun);

  if (json) {
    console.log(JSON.stringify({
      ok: true,
      dryRun,
      shadowMode: true,
      bestseller: {
        total: result.total,
        filtered: result.filtered,
        inserted: result.inserted,
      },
      trend,
      finishedAt: new Date().toISOString(),
    }));
  }
  process.exit(0);
}

main().catch(e => {
  console.error('[베스트셀러동기화] 오류:', e.message);
  process.exit(1);
});
