'use strict';

/**
 * bots/blog/lib/book-research.js — 도서리뷰 도서 정보 수집
 *
 * 1순위: 네이버 책 검색 API (NAVER_CLIENT_ID / NAVER_CLIENT_SECRET)
 * 2순위: Google Books API (GOOGLE_BOOKS_API_KEY — 선택)
 * 정책:
 *   - 후보 검색 -> 선택 -> 검증
 *   - API 모두 실패 시 null 반환
 *   - fallback 도서는 writer에 전달하지 않음
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
const {
  resolveNaverCredentials,
  resolveGoogleBooksApiKey,
} = require('../../../packages/core/lib/news-credentials');

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
  const { clientId, clientSecret } = await resolveNaverCredentials();
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

async function searchNaverBookByQuery(query) {
  const { clientId, clientSecret } = await resolveNaverCredentials();
  if (!clientId || !clientSecret || !query) return null;

  try {
    const url = `https://openapi.naver.com/v1/search/book.json?query=${encodeURIComponent(query)}&display=5&sort=sim`;
    const { status, body } = await httpsGet(url, {
      'X-Naver-Client-Id':     clientId,
      'X-Naver-Client-Secret': clientSecret,
    });

    if (status !== 200 || !body?.items?.length) return null;
    const item = body.items[0];
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
    console.warn('[도서] 네이버 재검증 실패:', e.message);
    return null;
  }
}

async function searchNaverBookCandidates() {
  const { clientId, clientSecret } = await resolveNaverCredentials();
  if (!clientId || !clientSecret) return [];

  const results = [];
  for (const keyword of buildSearchKeywords().slice(0, 4)) {
    try {
      const url = `https://openapi.naver.com/v1/search/book.json?query=${encodeURIComponent(keyword)}&display=5&sort=sim`;
      const { status, body } = await httpsGet(url, {
        'X-Naver-Client-Id':     clientId,
        'X-Naver-Client-Secret': clientSecret,
      });
      if (status !== 200 || !body?.items?.length) continue;

      for (const item of body.items.slice(0, 5)) {
        const isbn = (item.isbn || '').split(' ')[0];
        results.push({
          title: item.title,
          author: item.author,
          isbn,
          publisher: item.publisher,
          pubDate: item.pubdate,
          description: item.description,
          coverUrl: item.image || null,
          source: 'naver',
        });
      }
    } catch (e) {
      console.warn('[도서] 네이버 후보 검색 실패:', e.message);
    }
  }
  return uniqueByBookSignature(results);
}

// ─── Google Books API ─────────────────────────────────────────────────

/**
 * Google Books API — IT/개발 카테고리 신간
 * @returns {object|null}
 */
async function searchGoogleBook() {
  const apiKey = await resolveGoogleBooksApiKey();
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

async function searchGoogleBookByQuery(query) {
  const apiKey = await resolveGoogleBooksApiKey();
  if (!query) return null;
  const keyPart = apiKey ? `&key=${apiKey}` : '';

  try {
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5&orderBy=relevance&printType=books${keyPart}`;
    const { status, body } = await httpsGet(url);
    if (status !== 200 || !body?.items?.length) return null;

    const item  = body.items[0];
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
    console.warn('[도서] Google Books 재검증 실패:', e.message);
    return null;
  }
}

async function searchGoogleBookCandidates() {
  const apiKey = await resolveGoogleBooksApiKey();
  const keyPart = apiKey ? `&key=${apiKey}` : '';
  const results = [];

  for (const query of buildSearchKeywords().slice(0, 4)) {
    try {
      const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5&orderBy=relevance&printType=books${keyPart}`;
      const { status, body } = await httpsGet(url);
      if (status !== 200 || !body?.items?.length) continue;

      for (const item of body.items.slice(0, 5)) {
        const info = item.volumeInfo || {};
        const isbn = (info.industryIdentifiers || []).find(i => i.type === 'ISBN_13')?.identifier || '';
        results.push({
          title: info.title || '',
          author: (info.authors || []).join(', '),
          isbn,
          publisher: info.publisher || '',
          pubDate: info.publishedDate || '',
          description: info.description || '',
          coverUrl: info.imageLinks?.thumbnail?.replace('http://', 'https://') || null,
          source: 'google',
        });
      }
    } catch (e) {
      console.warn('[도서] Google 후보 검색 실패:', e.message);
    }
  }
  return uniqueByBookSignature(results);
}

// ─── 폴백 ─────────────────────────────────────────────────────────────

function getFallbackBook() {
  const book = FALLBACK_BOOKS[Math.floor(Math.random() * FALLBACK_BOOKS.length)];
  return { ...book, description: '', coverUrl: null, source: 'fallback' };
}

function normalizeBook(value = {}) {
  return {
    title: String(value.title || '').replace(/<[^>]+>/g, '').trim(),
    author: String(value.author || '').replace(/<[^>]+>/g, '').trim(),
    isbn: String(value.isbn || '').replace(/[^0-9]/g, ''),
    publisher: String(value.publisher || '').trim(),
    pubDate: String(value.pubDate || '').trim(),
    description: String(value.description || '').replace(/<[^>]+>/g, '').trim().slice(0, 500),
    coverUrl: value.coverUrl || null,
    source: String(value.source || '').trim(),
  };
}

function uniqueByBookSignature(items = []) {
  const seen = new Set();
  const unique = [];
  for (const item of items) {
    const normalized = normalizeBook(item);
    const signature = normalized.isbn || `${normalized.title}|${normalized.author}`;
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    unique.push(normalized);
  }
  return unique;
}

function scoreBookCandidate(candidate = {}, sourceFrequency = new Map()) {
  let score = 0;
  if (candidate.isbn && candidate.isbn.length === 13) score += 5;
  if (candidate.coverUrl) score += 2;
  if (candidate.description) score += 2;
  if (candidate.publisher) score += 1;
  score += Number(sourceFrequency.get(candidate.isbn || `${candidate.title}|${candidate.author}`) || 0) * 3;
  return score;
}

function buildSearchKeywords() {
  const topicKeywords = [
    '개발자 추천 도서',
    '개발자 자기계발 도서',
    '소프트웨어 설계 책',
    '클린 코드 책',
    'IT 트렌드 도서',
    'AI 인공지능 도서',
  ];
  const titleKeywords = FALLBACK_BOOKS.slice(0, 6).map((book) => book.title);
  return [...new Set([...topicKeywords, ...titleKeywords])];
}

// ─── 메인 ─────────────────────────────────────────────────────────────

async function searchBookCandidates() {
  const naverCandidates = await searchNaverBookCandidates();
  const googleCandidates = await searchGoogleBookCandidates();
  const merged = uniqueByBookSignature([...naverCandidates, ...googleCandidates]);

  const sourceFrequency = new Map();
  for (const item of [...naverCandidates, ...googleCandidates]) {
    const key = item.isbn || `${item.title}|${item.author}`;
    sourceFrequency.set(key, (sourceFrequency.get(key) || 0) + 1);
  }

  return merged
    .map((candidate) => ({ ...candidate, score: scoreBookCandidate(candidate, sourceFrequency) }))
    .sort((a, b) => b.score - a.score);
}

function selectBookCandidate(candidates = []) {
  if (!Array.isArray(candidates) || !candidates.length) return null;
  return candidates[0] || null;
}

/**
 * 도서리뷰용 책 정보 수집
 * 후보 검색 -> 선택 -> 재검증 순서
 *
 * @returns {{
 *   title, author, isbn, publisher, pubDate, description,
 *   coverUrl, coverPath, source, verification_candidates
 * } | null}
 */
async function researchBook() {
  console.log('[도서] 도서 후보 검색 시작...');

  const candidates = await searchBookCandidates();
  const primary = selectBookCandidate(candidates);
  if (!primary) {
    console.warn('[도서] 후보 검색 실패 — 사용 가능한 도서 API 결과 없음');
    return null;
  }

  const verificationCandidates = [primary];
  if (primary.title) {
    const query = [primary.title, primary.author].filter(Boolean).join(' ');
    if (primary.source === 'naver') {
      const googleCandidate = await searchGoogleBookByQuery(query);
      if (googleCandidate) verificationCandidates.push(googleCandidate);
    } else if (primary.source === 'google') {
      const naverCandidate = await searchNaverBookByQuery(query);
      if (naverCandidate) verificationCandidates.push(naverCandidate);
    }
  }

  const coverPath = primary.coverUrl ? await downloadCover(primary.coverUrl, primary.isbn) : null;
  const book = {
    ...primary,
    coverPath,
    verification_candidates: uniqueByBookSignature(verificationCandidates),
  };

  console.log(`[도서] ✅ 선택: ${book.title} — ${book.author} (${book.source})`);
  return book;
}

module.exports = {
  researchBook,
  downloadCover,
  searchBookCandidates,
  selectBookCandidate,
  searchNaverBookCandidates,
  searchGoogleBookCandidates,
  getFallbackBook,
};
