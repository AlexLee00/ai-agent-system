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
const ALADIN_WEB_BESTSELLER_BASE = 'https://www.aladin.co.kr/shop/common/wbest.aspx';
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

function stripHtml(value: string = ''): string {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBookText(value: string = ''): string {
  return stripHtml(value)
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^가-힣a-z0-9]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBookIsbn(value: string = ''): string {
  return String(value || '').replace(/[^0-9]/g, '');
}

function buildBookSignature(title: string = '', author: string = ''): string {
  const normalizedTitle = normalizeBookText(title);
  const normalizedAuthor = normalizeBookText(author).split(/\s*[,\^]\s*/)[0] || '';
  return [normalizedTitle, normalizedAuthor].filter(Boolean).join('|');
}

function parseKoreanMonth(value: string = ''): string {
  const matched = String(value || '').match(/(20\d{2})\s*년\s*(\d{1,2})\s*월/);
  if (!matched) return String(value || '').trim();
  return `${matched[1]}-${String(matched[2]).padStart(2, '0')}-01`;
}

async function fetchAladinWebBestsellers(
  categoryId: number,
  categoryName: string,
  maxResults: number = MAX_RESULTS_PER_CATEGORY
): Promise<AladinBook[]> {
  const url = new URL(ALADIN_WEB_BESTSELLER_BASE);
  url.searchParams.set('BranchType', '1');
  url.searchParams.set('CID', String(categoryId));
  url.searchParams.set('BestType', 'Bestseller');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 ai-agent-blog/1.0' },
    });
    if (!res.ok) throw new Error(`알라딘 웹 베스트셀러 실패: ${res.status} ${res.statusText}`);

    const html = await res.text();
    const chunks = html.split(/<div\s+class="ss_book_box"/i).slice(1);
    const books: AladinBook[] = [];
    for (const rawChunk of chunks) {
      const chunk = rawChunk.slice(0, rawChunk.indexOf('<div class="ss_book_box"') >= 0
        ? rawChunk.indexOf('<div class="ss_book_box"')
        : rawChunk.length);
      const linkMatch = chunk.match(/href="([^"]*\/shop\/wproduct\.aspx\?ItemId=\d+[^"]*)"/i);
      const titleMatch = chunk.match(/<a[^>]+class="bo3"[^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch || !titleMatch) continue;

      const detailLineMatch = chunk.match(/<li>\s*<a[^>]+AuthorSearch=[\s\S]*?<\/li>/i);
      const detailParts = stripHtml(detailLineMatch?.[0] || '').split('|').map((part) => part.trim()).filter(Boolean);
      const author = String(detailParts[0] || '').replace(/\([^)]*\)/g, '').trim();
      const publisher = detailParts[1] || '';
      const pubDate = parseKoreanMonth(detailParts[2] || '');
      const rating = Number(stripHtml(chunk.match(/<span class="star_score">([\s\S]*?)<\/span>/i)?.[1] || '0')) || 0;
      const salesPoint = Number(stripHtml(chunk.match(/<span class="sales_point">\s*([\d,]+)\s*<\/span>/i)?.[1] || '0').replace(/,/g, '')) || 0;
      const cover = (chunk.match(/<img[^>]+src="([^"]+)"[^>]*class="front_cover/i)?.[1] || '').replace(/^\/\//, 'https://');
      const reviewIsbn = chunk.match(/#([0-9]{13})_CommentReview/i)?.[1] || '';
      const link = linkMatch[1].startsWith('http') ? linkMatch[1] : `https://www.aladin.co.kr${linkMatch[1]}`;

      books.push({
        title: stripHtml(titleMatch[1]),
        author,
        publisher,
        isbn13: reviewIsbn,
        pubDate,
        customerReviewRank: rating,
        cover,
        link,
        categoryName,
        priceStandard: 0,
        salesPoint,
      });

      if (books.length >= maxResults) break;
    }
    return books;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 출간일로 최근성 계산 (개월 수)
 */
function calcRecencyMonths(pubDate: string): number {
  if (!pubDate) return 999;
  const pub = new Date(pubDate);
  const now = new Date();
  const diffMs = now.getTime() - pub.getTime();
  return Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30)));
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
 * 이미 리뷰되었거나 큐에 있는 도서 식별자 조회
 */
async function fetchReviewedBookKeys(): Promise<{ isbns: Set<string>; signatures: Set<string> }> {
  try {
    const rows = await pgPool.run('blog', `
      SELECT title, author, isbn FROM blog.book_catalog WHERE reviewed = true
      UNION
      SELECT title, author, isbn FROM blog.book_review_queue WHERE status IN ('done', 'queued')
    `);
    return {
      isbns: new Set((rows?.rows || []).map((r: any) => normalizeBookIsbn(r.isbn)).filter(Boolean)),
      signatures: new Set((rows?.rows || []).map((r: any) => buildBookSignature(r.title, r.author)).filter(Boolean)),
    };
  } catch {
    return { isbns: new Set(), signatures: new Set() };
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

  const reviewedBookKeys = await fetchReviewedBookKeys();
  const allBooks: RankedBook[] = [];
  const sourceCategories = ttbKey
    ? CATEGORIES
    : [{ id: 0, name: '도서', weight: 1.0 }];
  console.log(`[베스트셀러] 수집 시작 — ${sourceCategories.length}개 카테고리${ttbKey ? '' : ' (web fallback)'}`);

  // 카테고리별 병렬 수집
  const results = await Promise.allSettled(
    sourceCategories.map(async (cat) => {
      const books = ttbKey
        ? await fetchBestsellers(cat.id, ttbKey)
        : await fetchAladinWebBestsellers(cat.id, cat.name);
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

  const seenCandidateKeys = new Set<string>();
  const filtered = allBooks
    .filter(b => {
      const isbn = normalizeBookIsbn(b.isbn13);
      const signature = buildBookSignature(b.title, b.author);
      const candidateKey = isbn || signature;
      if (candidateKey && seenCandidateKeys.has(candidateKey)) return false;
      if (candidateKey) seenCandidateKeys.add(candidateKey);
      if (isbn && reviewedBookKeys.isbns.has(isbn)) return false;
      if (signature && reviewedBookKeys.signatures.has(signature)) return false;
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
