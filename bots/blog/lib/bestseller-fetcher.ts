// @ts-nocheck
'use strict';
/**
 * 알라딘 베스트셀러 페처 — H영역 (CODEX_BLOG_NEURAL_QUALITY_BOOST_V2)
 * 매주 월요일 자동 실행. 알라딘 Open API로 베스트셀러 수집 후 도서리뷰 큐 추가.
 *
 * API 키: secrets-store.json → ALADIN_TTB_KEY
 * 가입: https://www.aladin.co.kr/ttb/wblog_manage.aspx
 */

const path    = require('path');
const env     = require('../../../packages/core/lib/env');
const pgPool  = require('../../../packages/core/lib/pg-pool');
const kst     = require('../../../packages/core/lib/kst');
const { fetchHubSecrets } = require('../../../packages/core/lib/hub-client');

// 알라딘 카테고리 ID
const CATEGORIES = [
  { id: 170,  name: '자기계발',   weight: 1.3 },
  { id: 351,  name: '경제/경영',  weight: 1.2 },
  { id: 100,  name: '소설/시',    weight: 1.0 },
  { id: 656,  name: 'IT/컴퓨터', weight: 1.4 },
  { id: 798,  name: '인문',       weight: 1.1 },
  { id: 55889, name: '사회',      weight: 1.0 },
];

const ALADIN_API_BASE = 'https://www.aladin.co.kr/ttb/api/ItemList.aspx';
const MAX_RESULTS_PER_CATEGORY = 20;
const MIN_RATING = 3.5;
const RECENT_MONTHS = 12; // 최근 N개월 이내 출간만 포함

interface AladinBook {
  title: string;
  author: string;
  publisher: string;
  isbn13: string;
  pubDate: string;
  customerReviewRank: number;
  cover: string;
  link: string;
  categoryName: string;
  priceStandard: number;
  salesPoint?: number;
}

interface RankedBook extends AladinBook {
  category_name_local: string;
  final_score: number;
  recencyMonths: number;
}

/**
 * 알라딘 Open API 호출
 */
async function fetchBestsellers(
  categoryId: number,
  ttbKey: string,
  maxResults: number = MAX_RESULTS_PER_CATEGORY
): Promise<AladinBook[]> {
  const url = new URL(ALADIN_API_BASE);
  url.searchParams.set('ttbkey', ttbKey);
  url.searchParams.set('QueryType', 'Bestseller');
  url.searchParams.set('CategoryId', String(categoryId));
  url.searchParams.set('MaxResults', String(maxResults));
  url.searchParams.set('SearchTarget', 'Book');
  url.searchParams.set('Output', 'js');
  url.searchParams.set('Version', '20131101');
  url.searchParams.set('Cover', 'Big');

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`알라딘 API 실패: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  // JSONP 처리 (일부 경우)
  const cleanText = text.replace(/^[^{]*/, '').replace(/[^}]*$/, '');
  const data = JSON.parse(cleanText.length > 0 ? cleanText : text);
  return (data.item || []) as AladinBook[];
}

/**
 * 출간일로 최근성 계산 (개월 수)
 */
function calcRecencyMonths(pubDate: string): number {
  if (!pubDate) return 999;
  const pub = new Date(pubDate);
  const now = new Date();
  const diffMs = now.getTime() - pub.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30));
}

/**
 * 도서 최종 점수 계산
 */
function calcBookScore(book: AladinBook, categoryWeight: number): number {
  const rating = (book.customerReviewRank || 0) / 2; // 10점 → 5점 스케일
  const recencyMonths = calcRecencyMonths(book.pubDate);
  const recencyBonus = recencyMonths <= 3 ? 30 : recencyMonths <= 6 ? 20 : recencyMonths <= 12 ? 10 : 0;
  const salesBonus = book.salesPoint ? Math.min(book.salesPoint / 10000, 20) : 0;

  return (rating * 15 + recencyBonus + salesBonus) * categoryWeight;
}

/**
 * 이미 리뷰된 도서 ISBN 목록 조회
 */
async function fetchReviewedIsbns(): Promise<Set<string>> {
  try {
    const rows = await pgPool.run('blog', `
      SELECT isbn FROM blog.book_catalog WHERE reviewed = true
      UNION
      SELECT isbn FROM blog.book_review_queue WHERE status IN ('done', 'queued')
    `);
    return new Set((rows?.rows || []).map((r: any) => r.isbn).filter(Boolean));
  } catch {
    return new Set();
  }
}

/**
 * 도서리뷰 큐에 추가
 */
async function addToBookReviewQueue(books: RankedBook[]): Promise<number> {
  if (books.length === 0) return 0;
  let inserted = 0;

  for (const book of books) {
    try {
      const result = await pgPool.run('blog', `
        INSERT INTO blog.book_review_queue
          (title, author, publisher, isbn, category, priority, status, source, meta, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'queued', 'bestseller', $7, NOW())
        ON CONFLICT DO NOTHING
        RETURNING id
      `, [
        book.title,
        book.author,
        book.publisher,
        book.isbn13 || null,
        book.category_name_local || book.categoryName || '일반',
        Math.round(book.final_score),
        JSON.stringify({
          aladin_url: book.link,
          cover_url: book.cover,
          pub_date: book.pubDate,
          recency_months: book.recencyMonths,
          rating: book.customerReviewRank,
          price: book.priceStandard,
          sales_point: book.salesPoint,
          added_by: 'bestseller-fetcher',
          added_at: kst.today(),
        }),
      ]);
      if (result?.rowCount > 0) inserted++;
    } catch (e: any) {
      console.warn(`[베스트셀러] 큐 추가 실패 (${book.title}):`, e.message);
    }
  }

  return inserted;
}

/**
 * 메인: 베스트셀러 수집 + 큐 추가
 */
export async function runBestsellerFetch(options: { dryRun?: boolean } = {}): Promise<{
  total: number;
  filtered: number;
  inserted: number;
  books: RankedBook[];
}> {
  const blogSecrets = await fetchHubSecrets('blog', 3000, { silentStatuses: [404] }).catch(() => null);
  const ttbKey = blogSecrets?.ALADIN_TTB_KEY || process.env.ALADIN_TTB_KEY;

  if (!ttbKey) {
    console.log('[베스트셀러] ALADIN_TTB_KEY 없음 — 베스트셀러 동기화 skip');
    return { total: 0, filtered: 0, inserted: 0, books: [] };
  }

  console.log(`[베스트셀러] 수집 시작 — ${CATEGORIES.length}개 카테고리`);

  const reviewedIsbns = await fetchReviewedIsbns();
  const allBooks: RankedBook[] = [];

  // 카테고리별 병렬 수집
  const results = await Promise.allSettled(
    CATEGORIES.map(async (cat) => {
      const books = await fetchBestsellers(cat.id, ttbKey);
      return books.map(b => ({
        ...b,
        category_name_local: cat.name,
        recencyMonths: calcRecencyMonths(b.pubDate),
        final_score: calcBookScore(b, cat.weight),
      }));
    })
  );

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allBooks.push(...result.value);
    }
  }

  console.log(`[베스트셀러] 원본: ${allBooks.length}권`);

  // 필터링: 최근성 + 평점 + 미리뷰
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - RECENT_MONTHS);

  const filtered = allBooks
    .filter(b => {
      if (reviewedIsbns.has(b.isbn13)) return false;
      if ((b.customerReviewRank || 0) / 2 < MIN_RATING) return false;
      if (b.recencyMonths > RECENT_MONTHS) return false;
      return true;
    })
    .sort((a, b) => b.final_score - a.final_score)
    .slice(0, 20); // 최대 20권

  console.log(`[베스트셀러] 필터 후: ${filtered.length}권`);
  for (const b of filtered.slice(0, 10)) {
    console.log(`  - [${b.category_name_local}] ${b.title} (${b.author}) / 점수:${b.final_score.toFixed(1)} / ${b.recencyMonths}개월 전`);
  }

  if (options.dryRun) {
    console.log('[베스트셀러][dry-run] 큐 추가 생략');
    return { total: allBooks.length, filtered: filtered.length, inserted: 0, books: filtered };
  }

  const inserted = await addToBookReviewQueue(filtered);
  console.log(`[베스트셀러] 큐 추가: ${inserted}권`);

  return { total: allBooks.length, filtered: filtered.length, inserted, books: filtered };
}

// CLI 직접 실행
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  runBestsellerFetch({ dryRun })
    .then(result => {
      console.log('[베스트셀러] 완료:', JSON.stringify({ ...result, books: undefined }, null, 2));
      process.exit(0);
    })
    .catch(e => {
      console.error('[베스트셀러] 오류:', e.message);
      process.exit(1);
    });
}
