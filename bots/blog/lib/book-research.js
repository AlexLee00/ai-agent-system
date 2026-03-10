'use strict';

/**
 * bots/blog/lib/book-research.js — 도서리뷰 도서 정보 수집
 *
 * 1순위: 네이버 책 검색 API (NAVER_CLIENT_ID / NAVER_CLIENT_SECRET)
 * 2순위: Google Books API (GOOGLE_BOOKS_API_KEY — 선택)
 * 폴백:  베스트셀러 목록에서 랜덤 선택 (API 없을 때)
 *
 * 반환값:
 *   {
 *     title, author, isbn, publisher, pubDate,
 *     description, coverUrl, coverPath,  -- coverPath: 로컬 캐시 경로
 *     source,                            -- 'naver' | 'google' | 'fallback'
 *   }
 */

const https  = require('https');
const http   = require('http');
const fs     = require('fs');
const path   = require('path');

const COVER_DIR = path.join(__dirname, '..', 'output', 'images', 'books');

// ─── IT/자기계발 베스트셀러 폴백 목록 ────────────────────────────────

const FALLBACK_BOOKS = [
  { title: '소프트웨어 장인',       author: '산드로 만쿠소',    isbn: '9788960778139', publisher: '길벗' },
  { title: '클린 코드',            author: '로버트 마틴',       isbn: '9788966260959', publisher: '인사이트' },
  { title: '클린 아키텍처',        author: '로버트 마틴',       isbn: '9788966262472', publisher: '인사이트' },
  { title: '그릿',                 author: '앤절라 더크워스',   isbn: '9788925557045', publisher: '비즈니스북스' },
  { title: '원씽',                 author: '게리 켈러',         isbn: '9788901175157', publisher: '비즈니스북스' },
  { title: '아토믹 해빗',          author: '제임스 클리어',     isbn: '9788934985037', publisher: '비즈니스북스' },
  { title: '함께 자라기',          author: '김창준',            isbn: '9788966262335', publisher: '인사이트' },
  { title: '생각하는 프로그래밍',  author: '존 벤틀리',         isbn: '9788966260072', publisher: '인사이트' },
  { title: '피닉스 프로젝트',      author: '진 킴',             isbn: '9791185762791', publisher: '에이콘출판' },
  { title: '데브옵스 핸드북',      author: '진 킴',             isbn: '9791161751870', publisher: '에이콘출판' },
];

// ─── 헬퍼 ─────────────────────────────────────────────────────────────

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'ai-agent-blog/1.0', ...headers } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

/**
 * 책 표지 이미지 다운로드 (로컬 캐시)
 * @param {string} url
 * @param {string} isbn
 * @returns {string|null} 로컬 파일 경로
 */
async function downloadCover(url, isbn) {
  if (!url) return null;
  try {
    if (!fs.existsSync(COVER_DIR)) fs.mkdirSync(COVER_DIR, { recursive: true });
    const ext      = url.split('.').pop().split('?')[0] || 'jpg';
    const filename = `${isbn || Date.now()}.${ext}`;
    const filepath = path.join(COVER_DIR, filename);

    // 이미 캐시 있으면 재사용
    if (fs.existsSync(filepath)) return filepath;

    const lib  = url.startsWith('https') ? https : http;
    const data = await new Promise((resolve, reject) => {
      const chunks = [];
      lib.get(url, { headers: { 'User-Agent': 'ai-agent-blog/1.0' } }, res => {
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }).on('error', reject).setTimeout(10000);
    });
    fs.writeFileSync(filepath, data);
    return filepath;
  } catch (e) {
    console.warn('[도서] 표지 다운로드 실패:', e.message);
    return null;
  }
}

// ─── 네이버 책 검색 API ───────────────────────────────────────────────

/**
 * 네이버 책 검색 — 최신 IT/자기계발 베스트셀러
 * @returns {object|null}
 */
async function searchNaverBook() {
  const clientId     = process.env.NAVER_CLIENT_ID;
  const clientSecret = process.env.NAVER_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;

  try {
    // IT/자기계발 베스트셀러 중 랜덤 키워드로 검색
    const keywords = ['개발자 자기계발', 'IT 트렌드 2025', '소프트웨어 클린', '습관 성공', 'AI 인공지능 책'];
    const keyword  = keywords[Math.floor(Math.random() * keywords.length)];

    const url = `https://openapi.naver.com/v1/search/book.json?query=${encodeURIComponent(keyword)}&display=10&sort=sim`;
    const { status, body } = await httpsGet(url, {
      'X-Naver-Client-Id':     clientId,
      'X-Naver-Client-Secret': clientSecret,
    });

    if (status !== 200 || !body?.items?.length) return null;

    // 랜덤 선택 (상위 5개 중)
    const items = body.items.slice(0, 5);
    const item  = items[Math.floor(Math.random() * items.length)];

    const isbn = (item.isbn || '').split(' ')[0];
    return {
      title:       item.title?.replace(/<[^>]+>/g, '') || '',
      author:      item.author?.replace(/<[^>]+>/g, '') || '',
      isbn,
      publisher:   item.publisher || '',
      pubDate:     item.pubdate  || '',
      description: (item.description || '').replace(/<[^>]+>/g, '').slice(0, 500),
      coverUrl:    item.image || null,
      source:      'naver',
    };
  } catch (e) {
    console.warn('[도서] 네이버 검색 실패:', e.message);
    return null;
  }
}

// ─── Google Books API ─────────────────────────────────────────────────

/**
 * Google Books API — IT/개발 카테고리 신간
 * @returns {object|null}
 */
async function searchGoogleBook() {
  const apiKey = process.env.GOOGLE_BOOKS_API_KEY;
  const queries = ['subject:computers+language:ko', 'subject:self-help+language:ko', 'intitle:개발자'];
  const q       = queries[Math.floor(Math.random() * queries.length)];
  const keyPart = apiKey ? `&key=${apiKey}` : '';

  try {
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=10&orderBy=newest&printType=books${keyPart}`;
    const { status, body } = await httpsGet(url);
    if (status !== 200 || !body?.items?.length) return null;

    const items = body.items.slice(0, 5);
    const item  = items[Math.floor(Math.random() * items.length)];
    const info  = item.volumeInfo || {};
    const isbn  = (info.industryIdentifiers || []).find(i => i.type === 'ISBN_13')?.identifier || '';

    return {
      title:       info.title || '',
      author:      (info.authors || []).join(', '),
      isbn,
      publisher:   info.publisher || '',
      pubDate:     info.publishedDate || '',
      description: (info.description || '').slice(0, 500),
      coverUrl:    info.imageLinks?.thumbnail?.replace('http://', 'https://') || null,
      source:      'google',
    };
  } catch (e) {
    console.warn('[도서] Google Books 검색 실패:', e.message);
    return null;
  }
}

// ─── 폴백 ─────────────────────────────────────────────────────────────

function getFallbackBook() {
  const book = FALLBACK_BOOKS[Math.floor(Math.random() * FALLBACK_BOOKS.length)];
  return { ...book, description: '', coverUrl: null, source: 'fallback' };
}

// ─── 메인 ─────────────────────────────────────────────────────────────

/**
 * 도서리뷰용 책 정보 수집
 * 네이버 → Google Books → 폴백 순서
 *
 * @returns {{
 *   title, author, isbn, publisher, pubDate, description,
 *   coverUrl, coverPath, source
 * }}
 */
async function researchBook() {
  console.log('[도서] 도서 정보 수집 시작...');

  let book = await searchNaverBook()
    || await searchGoogleBook()
    || getFallbackBook();

  // 표지 이미지 다운로드
  const coverPath = book.coverUrl ? await downloadCover(book.coverUrl, book.isbn) : null;
  book = { ...book, coverPath };

  console.log(`[도서] ✅ ${book.title} — ${book.author} (${book.source})`);
  return book;
}

module.exports = { researchBook, downloadCover };
