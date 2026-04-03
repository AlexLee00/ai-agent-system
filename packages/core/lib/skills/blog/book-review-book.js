'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const {
  resolveNaverCredentials,
  resolveGoogleBooksApiKey,
} = require('../../news-credentials');
const { verifyBookSources } = require('./book-source-verify');

const COVER_DIR = path.join(__dirname, '..', '..', '..', '..', '..', 'bots', 'blog', 'output', 'images', 'books');

const CANONICAL_BOOKS = [
  { title: '소프트웨어 장인', author: '산드로 만쿠소', isbn: '9788968482397' },
  { title: '클린 코드', author: '로버트 마틴', isbn: '9788966260959' },
  { title: '클린 아키텍처', author: '로버트 마틴', isbn: '9788966262472' },
  { title: '함께 자라기', author: '김창준', isbn: '9788966262335' },
  { title: '피닉스 프로젝트', author: '진 킴', isbn: '9788966261437' },
  { title: '데브옵스 핸드북', author: '진 킴', isbn: '9788966261857' },
  { title: '아토믹 해빗', author: '제임스 클리어', isbn: '9788966262588' },
  { title: '원씽', author: '게리 켈러', isbn: '9788901153667' },
];

const DEFAULT_TOPIC_KEYWORDS = [
  '개발자 추천 도서',
  '소프트웨어 설계 책',
  '클린 코드 책',
  '개발 조직 문화 책',
  '개발자 자기계발 도서',
  'IT 트렌드 도서',
];

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'ai-agent-blog/1.0', ...headers } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
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

function uniqueByBookSignature(items = [], options = {}) {
  const seen = new Set();
  const unique = [];
  const keepSources = options.keepSources === true;
  for (const item of items) {
    if (!item) continue;
    const normalized = normalizeBook(item);
    const baseSignature = normalized.isbn || `${normalized.title}|${normalized.author}`;
    const signature = keepSources
      ? `${baseSignature}|${normalized.source || 'unknown'}`
      : baseSignature;
    if (!signature || seen.has(signature)) continue;
    seen.add(signature);
    unique.push(normalized);
  }
  return unique;
}

function buildSearchKeywords(input = {}) {
  const topic = String(input.topic || '').trim();
  const extraKeywords = Array.isArray(input.keywords)
    ? input.keywords.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const focusedKeywords = CANONICAL_BOOKS.map((book) => [book.title, book.author].filter(Boolean).join(' '));
  return [...new Set([
    ...(topic ? [topic] : []),
    ...extraKeywords,
    ...focusedKeywords,
    ...DEFAULT_TOPIC_KEYWORDS,
  ])];
}

function scoreBookCandidate(candidate = {}, sourceFrequency = new Map()) {
  let score = 0;
  if (candidate.isbn && candidate.isbn.length === 13) score += 5;
  if (candidate.coverUrl) score += 2;
  if (candidate.description) score += 2;
  if (candidate.publisher) score += 1;
  if (candidate.title && candidate.title.length <= 40) score += 2;
  if (candidate.author && !String(candidate.author).includes('^')) score += 1;
  if (/세트|전집|필독서|진로|교과연계/i.test(candidate.title || '')) score -= 4;
  score += Number(sourceFrequency.get(candidate.isbn || `${candidate.title}|${candidate.author}`) || 0) * 3;
  return score;
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\b[a-z]\b/gi, ' ')
    .replace(/[^가-힣a-z0-9]/gi, '')
    .trim();
}

function findCanonicalMatch(candidate = {}) {
  const title = normalizeText(candidate.title);
  const author = normalizeText(String(candidate.author || '').split(',')[0]);
  return CANONICAL_BOOKS.find((book) => {
    const bookTitle = normalizeText(book.title);
    const bookAuthor = normalizeText(book.author);
    const titleMatch = !!title && !!bookTitle && (title.includes(bookTitle) || bookTitle.includes(title));
    const authorMatch = !!author && !!bookAuthor
      ? (author.includes(bookAuthor) || bookAuthor.includes(author))
      : true;
    return titleMatch && authorMatch;
  }) || null;
}

async function downloadCover(url, isbn) {
  if (!url) return null;
  try {
    if (!fs.existsSync(COVER_DIR)) fs.mkdirSync(COVER_DIR, { recursive: true });
    const ext = url.split('.').pop().split('?')[0] || 'jpg';
    const filename = `${isbn || Date.now()}.${ext}`;
    const filepath = path.join(COVER_DIR, filename);
    if (fs.existsSync(filepath)) return filepath;

    const lib = url.startsWith('https') ? https : http;
    const data = await new Promise((resolve, reject) => {
      const chunks = [];
      const req = lib.get(url, { headers: { 'User-Agent': 'ai-agent-blog/1.0' } }, (res) => {
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('error', reject);
      req.setTimeout(10000, () => {
        req.destroy();
        reject(new Error('timeout'));
      });
    });
    fs.writeFileSync(filepath, data);
    return filepath;
  } catch (error) {
    console.warn('[도서스킬] 표지 다운로드 실패:', error.message);
    return null;
  }
}

async function searchNaverBookByQuery(query) {
  const { clientId, clientSecret } = await resolveNaverCredentials();
  if (!clientId || !clientSecret || !query) return null;

  try {
    const url = `https://openapi.naver.com/v1/search/book.json?query=${encodeURIComponent(query)}&display=5&sort=sim`;
    const { status, body } = await httpsGet(url, {
      'X-Naver-Client-Id': clientId,
      'X-Naver-Client-Secret': clientSecret,
    });
    if (status !== 200 || !body?.items?.length) return null;

    const item = body.items[0];
    const isbn = (item.isbn || '').split(' ')[0];
    return {
      title: item.title || '',
      author: item.author || '',
      isbn,
      publisher: item.publisher || '',
      pubDate: item.pubdate || '',
      description: item.description || '',
      coverUrl: item.image || null,
      source: 'naver',
    };
  } catch (error) {
    console.warn('[도서스킬] 네이버 검색 실패:', error.message);
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

    const item = body.items[0];
    const info = item.volumeInfo || {};
    const isbn = (info.industryIdentifiers || []).find((entry) => entry.type === 'ISBN_13')?.identifier || '';
    return {
      title: info.title || '',
      author: (info.authors || []).join(', '),
      isbn,
      publisher: info.publisher || '',
      pubDate: info.publishedDate || '',
      description: info.description || '',
      coverUrl: info.imageLinks?.thumbnail?.replace('http://', 'https://') || null,
      source: 'google',
    };
  } catch (error) {
    console.warn('[도서스킬] Google Books 검색 실패:', error.message);
    return null;
  }
}

async function searchNaverBookCandidates(input = {}) {
  const { clientId, clientSecret } = await resolveNaverCredentials();
  if (!clientId || !clientSecret) return [];

  const results = [];
  for (const keyword of buildSearchKeywords(input)) {
    try {
      const url = `https://openapi.naver.com/v1/search/book.json?query=${encodeURIComponent(keyword)}&display=5&sort=sim`;
      const { status, body } = await httpsGet(url, {
        'X-Naver-Client-Id': clientId,
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
    } catch (error) {
      console.warn('[도서스킬] 네이버 후보 검색 실패:', error.message);
    }
  }

  return uniqueByBookSignature(results);
}

async function searchGoogleBookCandidates(input = {}) {
  const apiKey = await resolveGoogleBooksApiKey();
  const keyPart = apiKey ? `&key=${apiKey}` : '';
  const results = [];

  for (const query of buildSearchKeywords(input)) {
    try {
      const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5&orderBy=relevance&printType=books${keyPart}`;
      const { status, body } = await httpsGet(url);
      if (status !== 200 || !body?.items?.length) continue;

      for (const item of body.items.slice(0, 5)) {
        const info = item.volumeInfo || {};
        const isbn = (info.industryIdentifiers || []).find((entry) => entry.type === 'ISBN_13')?.identifier || '';
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
    } catch (error) {
      console.warn('[도서스킬] Google 후보 검색 실패:', error.message);
    }
  }

  return uniqueByBookSignature(results);
}

async function searchBookCandidates(input = {}) {
  const [naverCandidates, googleCandidates] = await Promise.all([
    searchNaverBookCandidates(input),
    searchGoogleBookCandidates(input),
  ]);
  const merged = uniqueByBookSignature([...naverCandidates, ...googleCandidates]);

  const sourceFrequency = new Map();
  for (const item of [...naverCandidates, ...googleCandidates]) {
    const key = item.isbn || `${item.title}|${item.author}`;
    sourceFrequency.set(key, (sourceFrequency.get(key) || 0) + 1);
  }

  return merged
    .map((candidate) => ({ ...candidate, score: scoreBookCandidate(candidate, sourceFrequency) }))
    .sort((left, right) => right.score - left.score);
}

async function buildVerificationCandidates(primary) {
  const verificationCandidates = [primary];
  if (!primary?.title) return verificationCandidates;

  const query = [primary.title, primary.author].filter(Boolean).join(' ');
  const [naverCandidate, googleCandidate] = await Promise.all([
    primary.source === 'naver' ? Promise.resolve(null) : searchNaverBookByQuery(query),
    primary.source === 'google' ? Promise.resolve(null) : searchGoogleBookByQuery(query),
  ]);

  if (naverCandidate) verificationCandidates.push(naverCandidate);
  if (googleCandidate) verificationCandidates.push(googleCandidate);
  return uniqueByBookSignature(verificationCandidates, { keepSources: true });
}

async function searchCanonicalVerifiedBooks() {
  const verified = [];
  for (const book of CANONICAL_BOOKS) {
    const query = [book.title, book.author].filter(Boolean).join(' ');
    const [naverCandidate, googleCandidate] = await Promise.all([
      searchNaverBookByQuery(query),
      searchGoogleBookByQuery(query),
    ]);

    const primary = naverCandidate || googleCandidate;
    if (!primary) continue;

    const verificationCandidates = uniqueByBookSignature([
      primary,
      naverCandidate,
      googleCandidate,
      {
        title: book.title,
        author: book.author,
        isbn: book.isbn || primary.isbn,
        publisher: primary.publisher,
        pubDate: primary.pubDate,
        description: primary.description,
        coverUrl: primary.coverUrl,
        source: 'catalog',
      },
    ], { keepSources: true });
    const verification = verifyBookSources({
      primary,
      candidates: verificationCandidates,
    });
    if (!verification.ok) continue;

    verified.push({
      ...verification.book,
      verification_candidates: verificationCandidates,
      score: 100,
    });
  }

  return verified;
}

async function resolveBookForReview(input = {}) {
  const topicLabel = input.topic ? ` (${input.topic})` : '';
  console.log(`[도서스킬] 도서 후보 검색 시작...${topicLabel}`);
  const canonicalCandidates = await searchCanonicalVerifiedBooks();
  const candidates = canonicalCandidates.length
    ? canonicalCandidates
    : await searchBookCandidates(input);
  if (!candidates.length) return null;

  for (const primary of candidates.slice(0, 8)) {
    const verificationCandidates = await buildVerificationCandidates(primary);
    const resolvedPrimary = verificationCandidates.find((candidate) =>
      candidate && candidate.isbn && candidate.source !== 'catalog'
    ) || verificationCandidates.find((candidate) => candidate && candidate.isbn) || primary;
    const canonicalMatch = findCanonicalMatch(resolvedPrimary) || findCanonicalMatch(primary);
    if (canonicalMatch) {
      verificationCandidates.push({
        title: canonicalMatch.title,
        author: canonicalMatch.author,
        isbn: canonicalMatch.isbn || resolvedPrimary.isbn || primary.isbn || '',
        publisher: resolvedPrimary.publisher || primary.publisher,
        pubDate: resolvedPrimary.pubDate || primary.pubDate,
        description: resolvedPrimary.description || primary.description,
        coverUrl: resolvedPrimary.coverUrl || primary.coverUrl,
        source: 'catalog',
      });
    }
    const normalizedCandidates = uniqueByBookSignature(verificationCandidates, { keepSources: true });
    const verification = verifyBookSources({
      primary: resolvedPrimary,
      candidates: normalizedCandidates,
    });

    if (!verification.ok) {
      console.warn(`[도서스킬] 후보 제외: ${resolvedPrimary.title || primary.title} — ${verification.reasons.join(', ')}`);
      continue;
    }

    const coverPath = resolvedPrimary.coverUrl ? await downloadCover(resolvedPrimary.coverUrl, resolvedPrimary.isbn) : null;
    const book = {
      ...verification.book,
      coverPath,
      verification_candidates: normalizedCandidates,
    };

    console.log(`[도서스킬] ✅ 검증 선택: ${book.title} — ${book.author} (${book.source})`);
    return book;
  }

  return null;
}

module.exports = {
  resolveBookForReview,
  searchBookCandidates,
};
