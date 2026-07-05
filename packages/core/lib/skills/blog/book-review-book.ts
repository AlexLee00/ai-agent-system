// @ts-nocheck
'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const pgPool = require('../../pg-pool');
const env = require('../../env');

const {
  resolveNaverCredentials,
  resolveGoogleBooksApiKey,
  resolveData4LibraryKey,
  resolveKakaoApiKey,
} = require('../../news-credentials.legacy.js');
const { verifyBookSources } = require('./book-source-verify.ts');

const COVER_DIR = path.join(env.PROJECT_ROOT, 'bots', 'blog', 'output', 'images', 'books');
const COVER_SOURCE_PRIORITY = ['kakao', 'data4library', 'naver', 'google', 'openlibrary'];
const SOURCE_SCORE_MAP = {
  kakao: 6,
  data4library_recommend: 6,
  data4library: 5,
  naver: 5,
  google: 4,
  openlibrary: 3,
  catalog: 2,
};

const CANONICAL_BOOKS = [
  { title: '소프트웨어 장인', author: '산드로 만쿠소', isbn: '9788968482397' },
  { title: '클린 코드', author: '로버트 마틴', isbn: '9788966260959' },
  { title: '클린 아키텍처', author: '로버트 마틴', isbn: '9788966262472' },
  { title: '함께 자라기', author: '김창준', isbn: '9788966262335' },
  { title: '피닉스 프로젝트', author: '진 킴', isbn: '9788966261437' },
  { title: '데브옵스 핸드북', author: '진 킴', isbn: '9788966261857' },
  { title: '아토믹 해빗', author: '제임스 클리어', isbn: '9788966262588' },
  { title: '원씽', author: '게리 켈러', isbn: '9788901153667' },
  { title: '사피엔스', author: '유발 하라리', isbn: '9788934972464' },
  { title: '총 균 쇠', author: '재레드 다이아몬드', isbn: '9788972914891' },
  { title: '죽음의 수용소에서', author: '빅터 프랭클', isbn: '9788937464270' },
  { title: '어린 왕자', author: '앙투안 드 생텍쥐페리', isbn: '9788970633756' },
  { title: '데미안', author: '헤르만 헤세', isbn: '9788937460449' },
  { title: '아몬드', author: '손원평', isbn: '9791190090018' },
  { title: '불편한 편의점', author: '김호연', isbn: '9791161571188' },
  { title: '작별인사', author: '김영하', isbn: '9788936438838' },
];

const DEFAULT_TOPIC_KEYWORDS = [
  '개발자 추천 도서',
  '소프트웨어 설계 책',
  '클린 코드 책',
  '개발 조직 문화 책',
  '개발자 자기계발 도서',
  'IT 트렌드 도서',
  '인문학 추천 도서',
  '생각을 넓혀주는 책',
  '요즘 많이 읽는 소설',
  '베스트셀러 소설 추천',
  '일과 삶을 함께 돌아보는 책',
  '사람들이 많이 찾는 책',
  '화제의 베스트셀러',
  '시대가 바뀌어도 읽히는 고전',
  '관계와 삶을 돌아보게 하는 책',
];

const DEFAULT_CANONICAL_BOOKS = [...CANONICAL_BOOKS];

function normalizeBookKey(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^가-힣a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeBookIsbn(value = '') {
  return String(value || '').replace(/[^0-9]/g, '');
}

function normalizeBookAuthor(value = '') {
  return String(value || '')
    .split(/[,\^]/)
    .map((part) => normalizeBookKey(part))
    .filter(Boolean)[0] || '';
}

function normalizeReviewedBookKey(value = '') {
  return normalizeBookKey(value);
}

function safeMetadata(value = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

let bookReviewQueuePgForTest = null;
function getBookReviewQueuePg() {
  return bookReviewQueuePgForTest || pgPool;
}

function setBookReviewQueuePgForTest(mockPg = null) {
  const previous = bookReviewQueuePgForTest;
  bookReviewQueuePgForTest = mockPg;
  return () => {
    bookReviewQueuePgForTest = previous;
  };
}

function buildBookReviewQueueDedupeKey(book = {}) {
  const isbn = normalizeBookIsbn(book?.isbn || book?.book_isbn || book?.isbn13);
  if (isbn) return `isbn:${isbn}`;
  const titleKey = normalizeReviewedBookKey(book?.title || book?.book_title);
  return titleKey ? `title:${titleKey}` : '';
}

function buildQueueMetadata(book = {}, metadata = {}) {
  const dedupeKey = buildBookReviewQueueDedupeKey(book);
  const reviewDemand = book?.reviewDemand || book?.review_demand || null;
  const reviewDemandScore = Number(reviewDemand?.boost ?? book?.review_demand_score ?? 0);
  return {
    ...safeMetadata(book?.metadata),
    ...safeMetadata(book?.meta),
    ...safeMetadata(metadata),
    ...(dedupeKey ? { dedupe_key: dedupeKey } : {}),
    ...(reviewDemand ? { review_demand: reviewDemand } : {}),
    ...(reviewDemandScore > 0 ? { review_demand_score: reviewDemandScore } : {}),
  };
}

function sortQueueRowsForKeep(a = {}, b = {}) {
  const aTime = Date.parse(a?.created_at || a?.updated_at || '') || 0;
  const bTime = Date.parse(b?.created_at || b?.updated_at || '') || 0;
  if (aTime !== bTime) return bTime - aTime;
  return Number(b?.id || 0) - Number(a?.id || 0);
}

function sortQueueMatchesForStatus(rows = [], statusOrder = ['queued', 'selected', 'done']) {
  const rank = (row = {}) => {
    const status = String(row?.status || '').trim();
    const idx = statusOrder.indexOf(status);
    return idx >= 0 ? idx : statusOrder.length;
  };
  return [...rows].sort((a, b) => {
    const rankDiff = rank(a) - rank(b);
    if (rankDiff !== 0) return rankDiff;
    const aTime = Date.parse(a?.queue_date || a?.created_at || a?.updated_at || '') || 0;
    const bTime = Date.parse(b?.queue_date || b?.created_at || b?.updated_at || '') || 0;
    if (aTime !== bTime) return bTime - aTime;
    return Number(b?.id || 0) - Number(a?.id || 0);
  });
}

function buildBookReviewQueueCleanupPlan(rows = []) {
  const groups = new Map();
  for (const row of rows || []) {
    if (String(row?.status || 'queued') !== 'queued') continue;
    const key = buildBookReviewQueueDedupeKey(row);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const duplicateGroups = [];
  for (const [dedupeKey, groupRows] of groups.entries()) {
    if (groupRows.length < 2) continue;
    const sorted = [...groupRows].sort(sortQueueRowsForKeep);
    const keep = sorted[0];
    const duplicates = sorted.slice(1);
    duplicateGroups.push({
      dedupeKey,
      keepId: keep?.id,
      title: keep?.title,
      duplicateIds: duplicates.map((row) => row?.id).filter(Boolean),
      duplicateCount: duplicates.length,
    });
  }

  return {
    totalRows: rows.length,
    uniqueBooks: groups.size,
    duplicateRows: duplicateGroups.reduce((sum, group) => sum + group.duplicateCount, 0),
    groups: duplicateGroups,
  };
}

async function ensureBookCatalogTable() {
  try {
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_book_catalog_isbn_unique
      ON blog.book_catalog (isbn)
      WHERE isbn IS NOT NULL AND isbn <> ''
    `);

    await pgPool.run('blog', `
      CREATE INDEX IF NOT EXISTS idx_book_catalog_priority
      ON blog.book_catalog (priority DESC, added_at DESC)
    `);
  } catch (error) {
    console.warn('[도서스킬] book_catalog 테이블 보강 실패:', error.message);
  }
}

async function ensureBookReviewQueueTable() {
  try {
    const db = getBookReviewQueuePg();
    await db.run('blog', `
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

    await db.run('blog', `
      CREATE UNIQUE INDEX IF NOT EXISTS idx_book_review_queue_daily_unique
      ON blog.book_review_queue (queue_date, title, author)
    `);

    await db.run('blog', `
      CREATE INDEX IF NOT EXISTS idx_book_review_queue_status
      ON blog.book_review_queue (status, queue_date DESC, priority DESC)
    `);
  } catch (error) {
    console.warn('[도서스킬] book_review_queue 테이블 보강 실패:', error.message);
  }
}

async function seedCanonicalBooksToCatalog() {
  try {
    await ensureBookCatalogTable();
    for (const book of DEFAULT_CANONICAL_BOOKS) {
      await pgPool.run('blog', `
        INSERT INTO blog.book_catalog (title, author, isbn, category, priority, source)
        VALUES (?, ?, ?, ?, ?, 'canonical')
        ON CONFLICT DO NOTHING
      `, [
        book.title,
        book.author,
        book.isbn || null,
        inferCatalogCategory(book.title),
        100,
      ]);
    }
  } catch (error) {
    console.warn('[도서스킬] canonical 도서 시드 실패:', error.message);
  }
}

async function loadCatalogBooks() {
  try {
    await seedCanonicalBooksToCatalog();
    const rows = await pgPool.query('blog', `
      SELECT title, author, isbn, category, priority, source
      FROM blog.book_catalog
      ORDER BY priority DESC, added_at DESC
      LIMIT 50
    `);
    if (Array.isArray(rows) && rows.length > 0) {
      return rows.map((row) => ({
        title: row.title,
        author: row.author,
        isbn: row.isbn || '',
        category: row.category || 'IT',
        priority: Number(row.priority || 50),
        source: row.source || 'manual',
      }));
    }
  } catch (error) {
    console.warn('[도서스킬] book_catalog 조회 실패, 기본 목록 사용:', error.message);
  }
  return DEFAULT_CANONICAL_BOOKS.map((book) => ({ ...book, category: 'IT', priority: 100, source: 'canonical' }));
}

async function listBookCatalog(options = {}) {
  await ensureBookCatalogTable();

  const clauses = [];
  const params = [];

  if (typeof options.reviewed === 'boolean') {
    clauses.push(`reviewed = ?`);
    params.push(options.reviewed);
  }

  if (options.category) {
    clauses.push(`category = ?`);
    params.push(String(options.category).trim());
  }

  if (options.source) {
    clauses.push(`source = ?`);
    params.push(String(options.source).trim());
  }

  const limit = Math.max(1, Math.min(Number(options.limit || 20), 100));
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await pgPool.query('blog', `
    SELECT
      id,
      title,
      author,
      isbn,
      category,
      priority,
      reviewed,
      reviewed_date,
      source,
      metadata,
      added_at,
      updated_at
    FROM blog.book_catalog
    ${whereSql}
    ORDER BY reviewed ASC, priority DESC, added_at DESC
    LIMIT ${limit}
  `, params);

  return Array.isArray(rows) ? rows : [];
}

async function listBookReviewQueue(options = {}) {
  await ensureBookReviewQueueTable();
  const db = getBookReviewQueuePg();

  const clauses = [];
  const params = [];

  if (options.status) {
    clauses.push(`status = ?`);
    params.push(String(options.status).trim());
  }

  const limit = Math.max(1, Math.min(Number(options.limit || 20), 100));
  const whereSql = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const rows = await db.query('blog', `
    SELECT
      id,
      queue_date,
      title,
      author,
      isbn,
      category,
      priority,
      status,
      source,
      metadata,
      created_at,
      updated_at
    FROM blog.book_review_queue
    ${whereSql}
    ORDER BY queue_date DESC, priority DESC, created_at ASC
    LIMIT ${limit}
  `, params);

  return Array.isArray(rows) ? rows : [];
}

async function findBookReviewQueueEntryByDedupeKey(book = {}, options = {}) {
  await ensureBookReviewQueueTable();
  const db = getBookReviewQueuePg();
  const isbn = normalizeBookIsbn(book?.isbn || book?.book_isbn || book?.isbn13);
  const titleKey = normalizeReviewedBookKey(book?.title || book?.book_title);
  const statusOrder = Array.isArray(options.statusOrder) && options.statusOrder.length
    ? options.statusOrder.map((status) => String(status || '').trim()).filter(Boolean)
    : null;
  if (!isbn && !titleKey) return null;

  if (isbn) {
    const isbnRows = await db.query('blog', `
      SELECT id, title, author, isbn, status, metadata, created_at, updated_at
      FROM blog.book_review_queue
      WHERE isbn = ?
        AND status <> 'archived_duplicate'
      ORDER BY queue_date DESC, id DESC
      LIMIT 50
    `, [isbn]);
    const current = sortQueueMatchesForStatus(isbnRows || [], statusOrder || ['queued', 'selected', 'done'])[0];
    if (current?.id) return current;
  }

  if (!titleKey) return null;
  const rows = await db.query('blog', `
    SELECT id, title, author, isbn, status, metadata, created_at, updated_at
    FROM blog.book_review_queue
    WHERE status <> 'archived_duplicate'
    ORDER BY queue_date DESC, id DESC
    LIMIT 5000
  `);
  const matches = (rows || []).filter((row) => normalizeReviewedBookKey(row?.title) === titleKey);
  return sortQueueMatchesForStatus(matches, statusOrder || ['queued', 'selected', 'done'])[0] || null;
}

async function upsertBookReviewQueueEntry(book = {}, options = {}) {
  await ensureBookReviewQueueTable();
  const db = getBookReviewQueuePg();
  const title = String(book?.title || book?.book_title || '').trim();
  const author = String(book?.author || book?.book_author || '').trim() || '미상';
  const isbn = normalizeBookIsbn(book?.isbn || book?.book_isbn || book?.isbn13) || null;
  const category = String(book?.category || book?.category_name_local || book?.categoryName || '기타').trim();
  const priority = Number.isFinite(Number(book?.priority ?? book?.final_score))
    ? Math.round(Number(book?.priority ?? book?.final_score))
    : 50;
  const source = String(book?.source || options.source || 'catalog').trim();
  const metadata = buildQueueMetadata({ ...book, title, author, isbn }, options.metadata);
  const dedupeKey = buildBookReviewQueueDedupeKey({ title, isbn });
  if (!title) throw new Error('도서리뷰 큐 적재에는 title이 필요합니다');

  const current = await findBookReviewQueueEntryByDedupeKey({ title, isbn });
  if (current?.id) {
    const currentStatus = String(current.status || '').trim() || 'queued';
    if (currentStatus !== 'queued') {
      return {
        inserted: false,
        updated: false,
        id: current.id,
        dedupeKey,
        reason: `existing_${currentStatus}`,
      };
    }
    const nextMetadata = {
      ...safeMetadata(current.metadata),
      ...metadata,
      duplicate_seen_at: new Date().toISOString(),
    };
    const result = await db.run('blog', `
      UPDATE blog.book_review_queue
      SET author = CASE WHEN COALESCE(author, '') = '' THEN ? ELSE author END,
          isbn = COALESCE(NULLIF(isbn, ''), ?),
          category = ?,
          priority = GREATEST(COALESCE(priority, 0), ?),
          source = ?,
          metadata = ?::jsonb,
          updated_at = NOW()
      WHERE id = ?
    `, [
      author,
      isbn,
      category,
      priority,
      source,
      JSON.stringify(nextMetadata),
      current.id,
    ]);
    return {
      inserted: false,
      updated: Number(result?.rowCount || 0) > 0,
      id: current.id,
      dedupeKey,
    };
  }

  const result = await db.get('blog', `
    INSERT INTO blog.book_review_queue (
      queue_date, title, author, isbn, category, priority, status, source, metadata, updated_at
    )
    VALUES (
      CURRENT_DATE, ?, ?, ?, ?, ?, 'queued', ?, ?::jsonb, NOW()
    )
    ON CONFLICT (queue_date, title, author) DO UPDATE
      SET priority = GREATEST(COALESCE(blog.book_review_queue.priority, 0), EXCLUDED.priority),
          category = EXCLUDED.category,
          source = EXCLUDED.source,
          metadata = COALESCE(blog.book_review_queue.metadata, '{}'::jsonb) || EXCLUDED.metadata,
          updated_at = NOW()
    RETURNING id
  `, [
    title,
    author,
    isbn,
    category,
    priority,
    source,
    JSON.stringify(metadata),
  ]);

  return {
    inserted: true,
    updated: false,
    id: result?.id || null,
    dedupeKey,
  };
}

async function updateBookReviewQueueEntry(input = {}) {
  await ensureBookReviewQueueTable();
  const db = getBookReviewQueuePg();

  const isbn = normalizeBookIsbn(input.isbn);
  const title = String(input.title || '').trim();
  if (!isbn && !title) {
    throw new Error('queue 업데이트에는 isbn 또는 title이 필요합니다');
  }

  const targetStatus = String(input.status || '').trim();
  const statusOrder = targetStatus === 'done'
    ? ['selected', 'queued', 'done']
    : targetStatus === 'selected'
      ? ['queued', 'selected']
      : ['queued', 'selected', 'done'];
  const current = await findBookReviewQueueEntryByDedupeKey({ isbn, title }, { statusOrder });
  if (!current?.id) {
    return { updated: false, reason: '큐 항목 없음' };
  }

  const updates = [];
  const params = [];

  if (input.status) {
    updates.push('status = ?');
    params.push(String(input.status).trim());
  }

  const nextMetadata = {
    ...(current.metadata && typeof current.metadata === 'object' ? current.metadata : {}),
  };

  if (Number.isFinite(Number(input.postId))) nextMetadata.postId = Number(input.postId);
  if (input.note) nextMetadata.note = String(input.note).trim();
  if (String(input.status || '') === 'selected') nextMetadata.selected_at = new Date().toISOString();
  if (String(input.status || '') === 'done') nextMetadata.done_at = new Date().toISOString();
  if (Object.keys(nextMetadata).length > 0) {
    updates.push('metadata = ?::jsonb');
    params.push(JSON.stringify(nextMetadata));
  }

  if (!updates.length) {
    return { updated: false, reason: '변경할 값 없음' };
  }

  updates.push('updated_at = NOW()');
  params.push(current.id);

  const result = await db.run('blog', `
    UPDATE blog.book_review_queue
    SET ${updates.join(', ')}
    WHERE id = ?
  `, params);

  return {
    updated: Number(result?.rowCount || 0) > 0,
    id: current.id,
  };
}

async function updateBookCatalogEntry(input = {}) {
  await ensureBookCatalogTable();

  const isbnCandidates = [
    input.isbn,
    input.catalogIsbn,
    ...(Array.isArray(input.candidateIsbns) ? input.candidateIsbns : []),
  ]
    .map((value) => normalizeBookIsbn(value))
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index);
  const titleCandidates = [
    input.title,
    input.catalogTitle,
    ...(Array.isArray(input.candidateTitles) ? input.candidateTitles : []),
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .filter((value, index, arr) => arr.indexOf(value) === index);
  if (!isbnCandidates.length && !titleCandidates.length) {
    throw new Error('isbn 또는 title 중 하나는 필요합니다');
  }

  let current = null;
  for (const isbn of isbnCandidates) {
    current = await pgPool.get('blog', 'SELECT id, metadata FROM blog.book_catalog WHERE isbn = ? LIMIT 1', [isbn]);
    if (current?.id) break;
  }
  for (const title of titleCandidates) {
    if (current?.id) break;
    current = await pgPool.get('blog', 'SELECT id, metadata FROM blog.book_catalog WHERE title = ? LIMIT 1', [title]);
  }
  if (!current?.id && titleCandidates.length) {
    const normalizedTitles = new Set(titleCandidates.map((title) => normalizeBookKey(title)).filter(Boolean));
    const rows = await pgPool.query('blog', `
      SELECT id, title, metadata
      FROM blog.book_catalog
      ORDER BY priority DESC, added_at DESC
      LIMIT 300
    `);
    current = (rows || []).find((row) => {
      const rowTitle = normalizeBookKey(row?.title);
      return rowTitle && normalizedTitles.has(rowTitle);
    }) || null;
  }
  if (!current?.id) {
    throw new Error('대상 도서를 찾지 못했습니다');
  }

  const updates = [];
  const params = [];

  if (Number.isFinite(Number(input.priority))) {
    updates.push('priority = ?');
    params.push(Number(input.priority));
  }

  if (typeof input.reviewed === 'boolean') {
    updates.push('reviewed = ?');
    params.push(input.reviewed);
    updates.push(`reviewed_date = ${input.reviewed ? 'CURRENT_DATE' : 'NULL'}`);
  }

  if (input.category) {
    updates.push('category = ?');
    params.push(String(input.category).trim());
  }

  const nextMetadata = {
    ...(current.metadata && typeof current.metadata === 'object' ? current.metadata : {}),
  };

  if (input.coverUrl) nextMetadata.coverUrl = String(input.coverUrl).trim();
  if (input.descriptionSnippet) nextMetadata.descriptionSnippet = String(input.descriptionSnippet).trim().slice(0, 500);
  if (input.recommendedBy) nextMetadata.recommendedBy = String(input.recommendedBy).trim();

  if (Object.keys(nextMetadata).length > 0) {
    updates.push('metadata = ?::jsonb');
    params.push(JSON.stringify(nextMetadata));
  }

  if (!updates.length) {
    return { updated: false, reason: '변경할 값 없음' };
  }

  updates.push('updated_at = NOW()');
  params.push(current.id);

  const result = await pgPool.run('blog', `
    UPDATE blog.book_catalog
    SET ${updates.join(', ')}
    WHERE id = ?
  `, params);

  return {
    updated: Number(result?.rowCount || 0) > 0,
    id: current.id,
  };
}

async function syncPopularBooksToCatalog(options = {}) {
  await ensureBookCatalogTable();
  const popular = await searchData4LibraryPopular(options);
  if (!Array.isArray(popular) || popular.length === 0) {
    return { inserted: 0, scanned: 0 };
  }

  let inserted = 0;
  for (const book of popular.slice(0, 20)) {
    try {
      inserted += await upsertCatalogBook({
        ...book,
        category: inferCatalogCategory(book.title || ''),
        source: 'data4library',
        priority: Math.max(50, 50 + Math.floor(Number(book.loanCount || 0) / 10)),
        metadata: {
          loanCount: Number(book.loanCount || 0),
          ranking: Number(book.ranking || 0),
          source: 'data4library',
        },
      });
    } catch (error) {
      console.warn('[도서스킬] 인기대출 도서 저장 실패:', error.message);
    }
  }

  return {
    inserted,
    scanned: popular.slice(0, 20).length,
  };
}

async function upsertCatalogBook(input = {}) {
  const isbn = typeof input.isbn === 'string' ? input.isbn.trim() : '';
  const category = input.category || inferCatalogCategory(input.title || '');
  const priority = Number(input.priority || 50);
  const source = String(input.source || 'manual').trim();
  const metadata = JSON.stringify(input.metadata || {});
  let rowChanged = 0;

  if (isbn) {
    const updated = await pgPool.run('blog', `
      UPDATE blog.book_catalog
      SET title = ?,
          author = ?,
          category = ?,
          source = CASE
            WHEN source = 'canonical' THEN source
            ELSE ?
          END,
          priority = GREATEST(priority, ?),
          metadata = COALESCE(metadata, '{}'::jsonb) || ?::jsonb,
          updated_at = NOW()
      WHERE isbn = ?
    `, [
      input.title,
      input.author,
      category,
      source,
      priority,
      metadata,
      isbn,
    ]);
    rowChanged = Number(updated?.rowCount || 0);
  }

  if (!rowChanged) {
    const insertedRow = await pgPool.run('blog', `
      INSERT INTO blog.book_catalog (title, author, isbn, category, source, priority, metadata, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?::jsonb, NOW())
    `, [
      input.title,
      input.author,
      isbn || null,
      category,
      source,
      priority,
      metadata,
    ]);
    rowChanged = Number(insertedRow?.rowCount || 0);
  }

  return rowChanged > 0 ? 1 : 0;
}

async function syncRecommendedBooksToCatalog(options = {}) {
  await ensureBookCatalogTable();

  const seeds = [
    ...(Array.isArray(options.seedIsbns) ? options.seedIsbns : []),
    ...((await listBookCatalog({ limit: 6, source: 'data4library' })).map((book) => normalizeBookIsbn(book?.isbn))),
  ].filter(Boolean);
  const uniqueSeeds = [...new Set(seeds)].slice(0, 8);
  if (!uniqueSeeds.length) {
    return { inserted: 0, scanned: 0 };
  }

  let inserted = 0;
  let scanned = 0;
  for (const seedIsbn of uniqueSeeds) {
    try {
      const recommended = await searchData4LibraryRecommend(seedIsbn);
      for (const book of recommended.slice(0, 10)) {
        scanned += 1;
        inserted += await upsertCatalogBook({
          ...book,
          category: inferCatalogCategory(book.title || ''),
          source: 'data4library_recommend',
          priority: Math.max(40, 40 + Math.floor((10 - Math.min(10, scanned)) * 4)),
          metadata: {
            recommendationSeedIsbn: seedIsbn,
            source: 'data4library_recommend',
          },
        });
      }
    } catch (error) {
      console.warn('[도서스킬] 추천도서 저장 실패:', error.message);
    }
  }

  return { inserted, scanned };
}

async function loadReviewedBookHistory() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT publish_date, book_title, book_author, book_isbn, status
      FROM blog.publish_schedule
      WHERE post_type = 'general'
        AND category = '도서리뷰'
        AND status IN ('ready', 'published', 'archived')
        AND (book_title IS NOT NULL OR book_isbn IS NOT NULL)
      ORDER BY publish_date DESC
    `);
    return rows || [];
  } catch (error) {
    console.warn('[도서스킬] 도서리뷰 이력 조회 실패:', error.message);
    return [];
  }
}

function findReviewedBookMatch(book, history = []) {
  const isbn = normalizeBookIsbn(book?.isbn);
  const titleKey = normalizeBookKey(book?.title);
  if (!isbn && !titleKey) return null;

  return history.find((row) => {
    const rowIsbn = normalizeBookIsbn(row?.book_isbn);
    const rowTitleKey = normalizeBookKey(row?.book_title);
    if (isbn && rowIsbn && isbn === rowIsbn) return true;
    if (titleKey && rowTitleKey && titleKey === rowTitleKey) return true;
    return false;
  }) || null;
}

function httpsGet(url, headers = {}, options = {}) {
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
    req.setTimeout(Number(options.timeoutMs || 8000), () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
  });
}

function sleep(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function calculateReviewDemandBoost(total = 0, weight = 5) {
  const value = Math.max(0, Number(total || 0));
  if (!value) return 0;
  return Math.round(Math.log10(value + 1) * Number(weight || 5));
}

async function fetchNaverBookReviewDemand(title, options = {}) {
  const queryTitle = String(title || '').trim();
  if (!queryTitle) return { total: 0, boost: 0, skipped: true, reason: 'missing_title' };
  const credentials = options.credentials || await resolveNaverCredentials({ timeoutMs: options.secretTimeoutMs || 3000 }).catch(() => ({}));
  const { clientId, clientSecret } = credentials;
  if (!clientId || !clientSecret) return { total: 0, boost: 0, skipped: true, reason: 'missing_naver_credentials' };

  const query = `${queryTitle} 서평`;
  const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query)}&display=1&sort=sim`;
  const request = options.fetchJson
    ? options.fetchJson(url, { clientId, clientSecret, query })
    : httpsGet(url, {
      'X-Naver-Client-Id': clientId,
      'X-Naver-Client-Secret': clientSecret,
    }, { timeoutMs: options.timeoutMs || 8000 });
  const response = await request.catch((error) => ({ error }));
  if (response?.error) {
    return { total: 0, boost: 0, skipped: true, reason: response.error.message || 'naver_request_failed' };
  }
  const body = response?.body || response;
  const total = Math.max(0, Number(body?.total || 0));
  return {
    total,
    boost: calculateReviewDemandBoost(total, options.weight || 5),
    query,
    skipped: false,
  };
}

async function enrichBooksWithReviewDemand(books = [], options = {}) {
  const result = [];
  const delayMs = Math.max(0, Number(options.delayMs ?? 250));
  const credentials = options.credentials || await resolveNaverCredentials({ timeoutMs: options.secretTimeoutMs || 3000 }).catch(() => ({}));
  for (const book of books || []) {
    const demand = await fetchNaverBookReviewDemand(book?.title || book?.book_title, {
      ...options,
      credentials,
    });
    result.push({
      ...book,
      priority: Number(book?.priority ?? book?.final_score ?? 50) + Number(demand.boost || 0),
      reviewDemand: demand,
    });
    if (delayMs > 0) await sleep(delayMs);
  }
  return result;
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
    sourceScore: Number(value.sourceScore || 0),
    sourceCount: Number(value.sourceCount || 0),
    editionCount: Number(value.editionCount || 0),
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

function buildSearchKeywords(input = {}, catalogBooks = DEFAULT_CANONICAL_BOOKS) {
  const topic = String(input.topic || '').trim();
  const extraKeywords = Array.isArray(input.keywords)
    ? input.keywords.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const preferredKeywords = Array.isArray(input.preferredBooks)
    ? input.preferredBooks
      .map((book) => [book?.title, book?.author].filter(Boolean).join(' ').trim())
      .filter(Boolean)
    : [];
  const focusedKeywords = catalogBooks.map((book) => [book.title, book.author].filter(Boolean).join(' '));
  return [...new Set([
    ...(topic ? [topic] : []),
    ...extraKeywords,
    ...preferredKeywords,
    ...focusedKeywords,
    ...DEFAULT_TOPIC_KEYWORDS,
  ])];
}

function inferCatalogCategory(title = '') {
  if (/아토믹 해빗|원씽|함께 자라기|죽음의 수용소에서|열한 계단|공부머리 독서법/.test(title)) return '자기계발';
  if (/사피엔스|총 균 쇠|책은 도끼다|지적 대화를 위한 넓고 얕은 지식|시민의 교양|지대넓얕/.test(title)) return '인문학';
  if (/어린 왕자|데미안|아몬드|불편한 편의점|작별인사/.test(title)) return '소설';
  return 'IT';
}

function buildDiversePreferredBooks(catalogBooks = [], limit = 5, reviewedHistory = []) {
  const groups = new Map();
  for (const book of catalogBooks) {
    const category = String(book?.category || inferCatalogCategory(book?.title || '') || '기타').trim();
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(book);
  }

  const recentAuthors = new Set(
    (reviewedHistory || [])
      .slice(0, 8)
      .map((row) => normalizeBookAuthor(row?.book_author))
      .filter(Boolean)
  );
  const recentTitles = new Set(
    (reviewedHistory || [])
      .slice(0, 8)
      .map((row) => normalizeBookKey(row?.book_title))
      .filter(Boolean)
  );

  for (const [category, items] of groups.entries()) {
    groups.set(category, [...items].sort((a, b) => {
      const aAuthor = normalizeBookAuthor(a?.author);
      const bAuthor = normalizeBookAuthor(b?.author);
      const aTitle = normalizeBookKey(a?.title);
      const bTitle = normalizeBookKey(b?.title);
      const aPenalty = (recentAuthors.has(aAuthor) ? 10 : 0) + (recentTitles.has(aTitle) ? 20 : 0);
      const bPenalty = (recentAuthors.has(bAuthor) ? 10 : 0) + (recentTitles.has(bTitle) ? 20 : 0);
      return (Number(b?.priority || 0) - bPenalty) - (Number(a?.priority || 0) - aPenalty);
    }));
  }

  const preferredOrder = ['IT', '자기계발', '인문학', '소설'];
  const result = [];
  const categoryCap = new Map([
    ['IT', 2],
    ['자기계발', 2],
    ['인문학', 2],
    ['소설', 2],
  ]);
  const categoryCount = new Map();
  const canTake = (category) => (categoryCount.get(category) || 0) < (categoryCap.get(category) || limit);
  const markTaken = (category) => categoryCount.set(category, (categoryCount.get(category) || 0) + 1);

  for (const category of preferredOrder) {
    const items = groups.get(category) || [];
    if (items.length && canTake(category)) {
      result.push(items[0]);
      markTaken(category);
    }
    if (result.length >= limit) return result.slice(0, limit);
  }

  for (const [category, items] of groups.entries()) {
    for (const item of items) {
      if (result.includes(item)) continue;
      if (!canTake(category)) continue;
      result.push(item);
      markTaken(category);
      if (result.length >= limit) return result.slice(0, limit);
    }
  }

  return result.slice(0, limit);
}

function buildBalancedBookReviewSeeds({
  queuedBooks = [],
  catalogBooks = [],
  reviewedHistory = [],
  queueLimit = 3,
  totalLimit = 6,
} = {}) {
  const seen = new Set();
  const queueSeeds = [];
  for (const book of queuedBooks || []) {
    const key = buildBookReviewQueueDedupeKey(book);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    queueSeeds.push({
      title: book.title,
      author: book.author,
      isbn: book.isbn || '',
      category: book.category || '기타',
      priority: Number(book.priority || 50),
      source: book.source || 'queue',
      queueId: book.id || null,
      fromQueue: true,
    });
    if (queueSeeds.length >= queueLimit) break;
  }

  const catalogSeeds = [];
  const candidates = buildDiversePreferredBooks(catalogBooks, Math.max(totalLimit * 2, 12), reviewedHistory);
  for (const book of candidates || []) {
    const key = buildBookReviewQueueDedupeKey(book);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    catalogSeeds.push({
      title: book.title,
      author: book.author,
      isbn: book.isbn || '',
      category: book.category || inferCatalogCategory(book.title),
      priority: Number(book.priority || 50),
      source: book.source || 'catalog',
      fromCatalog: true,
    });
    if (queueSeeds.length + catalogSeeds.length >= totalLimit) break;
  }

  return [...queueSeeds, ...catalogSeeds].slice(0, totalLimit);
}

async function buildBookReviewQueue(options = {}) {
  await ensureBookReviewQueueTable();
  const limit = Math.max(1, Math.min(Number(options.limit || 5), 20));
  const catalogBooks = await loadCatalogBooks();
  const reviewedHistory = await loadReviewedBookHistory();
  const preferredBooks = buildDiversePreferredBooks(catalogBooks, Math.max(limit * 2, 8), reviewedHistory);

  const selected = [];
  const existingKeys = new Set();
  for (const book of preferredBooks) {
    const key = buildBookReviewQueueDedupeKey(book);
    if (!key) continue;
    if (existingKeys.has(key)) continue;
    selected.push(book);
    existingKeys.add(key);
    if (selected.length >= limit) break;
  }

  const demandBooks = options.skipDemand
    ? selected
    : await enrichBooksWithReviewDemand(selected, {
      delayMs: options.demandDelayMs ?? 250,
      secretTimeoutMs: options.secretTimeoutMs || 3000,
    }).catch((error) => {
      console.warn('[도서스킬] 네이버 서평 수요 점수 보강 실패:', error.message);
      return selected;
    });

  let inserted = 0;
  let updated = 0;
  for (const book of demandBooks) {
    const metadata = {
      category: book.category || inferCatalogCategory(book.title),
      preferred: true,
      builtAt: new Date().toISOString(),
    };

    const result = await upsertBookReviewQueueEntry(book, { source: book.source || 'catalog', metadata });
    if (result.inserted) inserted += 1;
    else if (result.updated) updated += 1;
  }

  const rows = await listBookReviewQueue({ limit, status: 'queued' });
  return {
    inserted,
    updated,
    scanned: preferredBooks.length,
    rows,
  };
}

function pickBestCoverUrl(candidates = []) {
  for (const source of COVER_SOURCE_PRIORITY) {
    const matched = candidates.find((candidate) => candidate?.source === source && candidate?.coverUrl);
    if (matched) return matched.coverUrl;
  }
  return candidates.find((candidate) => candidate?.coverUrl)?.coverUrl || null;
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
  score += Number(candidate.sourceScore || SOURCE_SCORE_MAP[candidate.source] || 0);
  score += Number(candidate.reviewDemand?.boost ?? candidate.review_demand_score ?? 0);
  score += Number(candidate.editionCount || 0) > 0 ? Math.min(2, Math.floor(Number(candidate.editionCount || 0) / 5)) : 0;
  score += Number(sourceFrequency.get(candidate.isbn || `${candidate.title}|${candidate.author}`) || 0) * 4;
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

function findCanonicalMatch(candidate = {}, catalogBooks = DEFAULT_CANONICAL_BOOKS) {
  const title = normalizeText(candidate.title);
  const author = normalizeText(String(candidate.author || '').split(',')[0]);
  return catalogBooks.find((book) => {
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
  if (!apiKey) return null;
  const keyPart = apiKey ? `&key=${apiKey}` : '';

  try {
    const url = `https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=5&orderBy=relevance&printType=books${keyPart}`;
    const { status, body } = await httpsGet(url, {}, { timeoutMs: 15000 });
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

async function searchNaverBookCandidates(input = {}, catalogBooks = DEFAULT_CANONICAL_BOOKS) {
  const { clientId, clientSecret } = await resolveNaverCredentials();
  if (!clientId || !clientSecret) return [];

  const results = [];
  for (const keyword of buildSearchKeywords(input, catalogBooks)) {
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

async function searchGoogleBookCandidates(input = {}, catalogBooks = DEFAULT_CANONICAL_BOOKS) {
  const apiKey = await resolveGoogleBooksApiKey();
  if (!apiKey) return [];
  const keyPart = apiKey ? `&key=${apiKey}` : '';
  const results = [];

  for (const query of buildSearchKeywords(input, catalogBooks)) {
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

function mapOpenLibraryDocs(docs = []) {
  return docs.slice(0, 5).map((doc) => ({
    title: doc.title || '',
    author: (doc.author_name || []).join(', '),
    isbn: (doc.isbn || []).find((value) => String(value || '').replace(/[^0-9]/g, '').length === 13) || '',
    publisher: (doc.publisher || [])[0] || '',
    pubDate: String(doc.first_publish_year || ''),
    description: '',
    coverUrl: doc.cover_i ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : null,
    source: 'openlibrary',
    editionCount: doc.edition_count || 0,
  }));
}

async function searchOpenLibrary(query) {
  if (!query) return [];

  try {
    const korUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=5&language=kor`;
    const kor = await httpsGet(korUrl, {}, { timeoutMs: 15000 });
    if (kor.status === 200 && kor.body?.docs?.length) return mapOpenLibraryDocs(kor.body.docs);

    const globalUrl = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=5`;
    const global = await httpsGet(globalUrl, {}, { timeoutMs: 15000 });
    if (global.status !== 200 || !global.body?.docs?.length) return [];
    return mapOpenLibraryDocs(global.body.docs);
  } catch (error) {
    console.warn('[도서스킬] Open Library 검색 실패:', error.message);
    return [];
  }
}

async function searchOpenLibraryCandidates(input = {}, catalogBooks = DEFAULT_CANONICAL_BOOKS) {
  const results = [];
  for (const query of buildSearchKeywords(input, catalogBooks)) {
    const found = await searchOpenLibrary(query);
    results.push(...found);
  }
  return uniqueByBookSignature(results);
}

async function searchData4LibraryPopular(options = {}) {
  const authKey = await resolveData4LibraryKey();
  if (!authKey) return [];
  // 주의:
  // 도서관 정보나루는 인증키를 저장한 직후에도 별도 승인 완료 전까지
  // 빈 응답 또는 실패 응답이 올 수 있다. 이 경우 전체 도서 검색을 깨지 않게
  // 빈 배열로 안전하게 내려서 다른 소스(네이버/카카오/Open Library)로 계속 진행한다.

  const params = new URLSearchParams({
    authKey,
    pageNo: '1',
    pageSize: '20',
    format: 'json',
  });
  if (options.age) params.set('age', String(options.age));
  if (options.kdc) params.set('kdc', String(options.kdc));

  try {
    const url = `https://data4library.kr/api/loanItemSrch?${params.toString()}`;
    const { status, body } = await httpsGet(url);
    if (status !== 200) return [];

    const docs = body?.response?.docs || [];
    return docs.map((doc) => ({
      title: doc.doc?.bookname || '',
      author: doc.doc?.authors || '',
      isbn: doc.doc?.isbn13 || '',
      publisher: doc.doc?.publisher || '',
      pubDate: String(doc.doc?.publication_year || ''),
      description: '',
      coverUrl: doc.doc?.bookImageURL || null,
      source: 'data4library',
      loanCount: Number(doc.doc?.loan_count || 0),
      ranking: Number(doc.doc?.ranking || 0),
    }));
  } catch (error) {
    console.warn('[도서스킬] 정보나루 인기도서 실패:', error.message);
    return [];
  }
}

async function searchData4LibraryRecommend(isbn) {
  const authKey = await resolveData4LibraryKey();
  const normalizedIsbn = normalizeBookIsbn(isbn);
  if (!authKey || !normalizedIsbn) return [];

  try {
    const params = new URLSearchParams({
      authKey,
      isbn13: normalizedIsbn,
      type: 'reader',
      format: 'json',
    });
    const url = `https://data4library.kr/api/recommandList?${params.toString()}`;
    const { status, body } = await httpsGet(url);
    if (status !== 200) return [];

    const docs = body?.response?.docs || [];
    return docs.slice(0, 10).map((doc) => ({
      title: doc.book?.bookname || '',
      author: doc.book?.authors || '',
      isbn: doc.book?.isbn13 || '',
      publisher: doc.book?.publisher || '',
      pubDate: String(doc.book?.publication_year || ''),
      description: '',
      coverUrl: doc.book?.bookImageURL || null,
      source: 'data4library_recommend',
      recommendationSeedIsbn: normalizedIsbn,
    }));
  } catch (error) {
    console.warn('[도서스킬] 정보나루 추천도서 실패:', error.message);
    return [];
  }
}

async function searchKakaoBook(query) {
  const apiKey = await resolveKakaoApiKey();
  if (!apiKey || !query) return [];

  try {
    const url = `https://dapi.kakao.com/v3/search/book?query=${encodeURIComponent(query)}&size=5&sort=accuracy`;
    const { status, body } = await httpsGet(url, {
      Authorization: `KakaoAK ${apiKey}`,
    });
    if (status !== 200 || !body?.documents?.length) return [];

    return body.documents.map((doc) => ({
      title: doc.title || '',
      author: (doc.authors || []).join(', '),
      isbn: String(doc.isbn || '').split(' ').find((value) => String(value || '').length === 13) || '',
      publisher: doc.publisher || '',
      pubDate: String(doc.datetime || '').slice(0, 10),
      description: String(doc.contents || '').slice(0, 500),
      coverUrl: doc.thumbnail || null,
      source: 'kakao',
      price: Number(doc.price || 0),
      salePrice: Number(doc.sale_price || 0),
      url: doc.url || '',
    }));
  } catch (error) {
    console.warn('[도서스킬] 카카오 검색 실패:', error.message);
    return [];
  }
}

async function searchKakaoBookCandidates(input = {}, catalogBooks = DEFAULT_CANONICAL_BOOKS) {
  const results = [];
  for (const query of buildSearchKeywords(input, catalogBooks)) {
    const found = await searchKakaoBook(query);
    results.push(...found);
  }
  return uniqueByBookSignature(results);
}

async function searchBookCandidates(input = {}) {
  const catalogBooks = await loadCatalogBooks();
  const data4libraryCandidates = await searchData4LibraryPopular({
    kdc: input.kdc || '',
    age: input.age || '',
  });
  const recommendationSeedIsbns = [
    ...data4libraryCandidates.slice(0, 3).map((book) => normalizeBookIsbn(book?.isbn)),
    ...catalogBooks.slice(0, 3).map((book) => normalizeBookIsbn(book?.isbn)),
    normalizeBookIsbn(input.isbn),
  ].filter(Boolean);
  const uniqueRecommendationSeeds = [...new Set(recommendationSeedIsbns)].slice(0, 5);

  const [
    data4libraryRecommended,
    naverCandidates,
    kakaoCandidates,
    googleCandidates,
    openLibraryCandidates,
  ] = await Promise.all([
    Promise.all(uniqueRecommendationSeeds.map((isbn) => searchData4LibraryRecommend(isbn))).then((groups) => groups.flat()),
    searchNaverBookCandidates(input, catalogBooks),
    searchKakaoBookCandidates(input, catalogBooks),
    searchGoogleBookCandidates(input, catalogBooks),
    searchOpenLibraryCandidates(input, catalogBooks),
  ]);
  const allCandidates = [
    ...data4libraryCandidates,
    ...data4libraryRecommended,
    ...naverCandidates,
    ...kakaoCandidates,
    ...googleCandidates,
    ...openLibraryCandidates,
  ];
  const merged = uniqueByBookSignature(allCandidates).map((candidate) => {
    const key = candidate.isbn || `${candidate.title}|${candidate.author}`;
    return {
      ...candidate,
      sourceCount: 0,
      coverUrl: candidate.coverUrl,
      sourceScore: SOURCE_SCORE_MAP[candidate.source] || 0,
      key,
    };
  });

  const sourceFrequency = new Map();
  for (const item of allCandidates) {
    const key = item.isbn || `${item.title}|${item.author}`;
    sourceFrequency.set(key, (sourceFrequency.get(key) || 0) + 1);
  }

  return merged
    .map((candidate) => {
      const key = candidate.key || candidate.isbn || `${candidate.title}|${candidate.author}`;
      const siblings = allCandidates.filter((item) => (item.isbn || `${item.title}|${item.author}`) === key);
      return {
        ...candidate,
        sourceCount: Number(sourceFrequency.get(key) || 0),
        coverUrl: pickBestCoverUrl(siblings) || candidate.coverUrl,
        score: scoreBookCandidate({
          ...candidate,
          sourceCount: Number(sourceFrequency.get(key) || 0),
          coverUrl: pickBestCoverUrl(siblings) || candidate.coverUrl,
        }, sourceFrequency),
      };
    })
    .sort((left, right) => right.score - left.score);
}

async function buildVerificationCandidates(primary) {
  const verificationCandidates = [primary];
  if (!primary?.title) return verificationCandidates;

  const query = [primary.title, primary.author].filter(Boolean).join(' ');
  const [naverCandidate, googleCandidate, openLibraryCandidates] = await Promise.all([
    primary.source === 'naver' ? Promise.resolve(null) : searchNaverBookByQuery(query),
    primary.source === 'google' ? Promise.resolve(null) : searchGoogleBookByQuery(query),
    primary.source === 'openlibrary' ? Promise.resolve([]) : searchOpenLibrary(query),
  ]);

  if (naverCandidate) verificationCandidates.push(naverCandidate);
  if (googleCandidate) verificationCandidates.push(googleCandidate);
  verificationCandidates.push(...(openLibraryCandidates || []));
  return uniqueByBookSignature(verificationCandidates, { keepSources: true });
}

async function searchCanonicalVerifiedBooks() {
  const catalogBooks = await loadCatalogBooks();
  const verified = [];
  for (const book of catalogBooks) {
    const query = [book.title, book.author].filter(Boolean).join(' ');
    const [naverCandidate, googleCandidate, openLibraryCandidates] = await Promise.all([
      searchNaverBookByQuery(query),
      searchGoogleBookByQuery(query),
      searchOpenLibrary(query),
    ]);

    const primary = naverCandidate || googleCandidate || (openLibraryCandidates || [])[0] || null;
    if (!primary) continue;

    const verificationCandidates = uniqueByBookSignature([
      primary,
      naverCandidate,
      googleCandidate,
      ...(openLibraryCandidates || []),
      {
        title: book.title,
        author: book.author,
        isbn: book.isbn || primary.isbn,
        publisher: primary.publisher,
        pubDate: primary.pubDate,
        description: primary.description,
        coverUrl: pickBestCoverUrl([naverCandidate, googleCandidate, ...(openLibraryCandidates || []), primary].filter(Boolean)),
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
      coverUrl: pickBestCoverUrl(verificationCandidates) || verification.book.coverUrl || null,
      score: 100,
    });
  }

  return verified;
}

async function selectVerifiedBookCandidate(candidates = [], reviewedHistory = []) {
  if (!candidates.length) return null;
  const catalogBooks = await loadCatalogBooks();
  for (const primary of candidates.slice(0, 8)) {
    const verificationCandidates = await buildVerificationCandidates(primary);
    const resolvedPrimary = verificationCandidates.find((candidate) =>
      candidate && candidate.isbn && candidate.source !== 'catalog'
    ) || verificationCandidates.find((candidate) => candidate && candidate.isbn) || primary;
    const canonicalMatch = findCanonicalMatch(resolvedPrimary, catalogBooks) || findCanonicalMatch(primary, catalogBooks);
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
      coverUrl: pickBestCoverUrl(normalizedCandidates) || verification.book.coverUrl || null,
      coverPath,
      verification_candidates: normalizedCandidates,
    };

    const duplicateMatch = findReviewedBookMatch(book, reviewedHistory);
    if (duplicateMatch) {
      console.warn(
        `[도서스킬] 후보 제외: ${book.title} — 기존 도서리뷰와 중복 (${duplicateMatch.publish_date}, ${duplicateMatch.status})`
      );
      continue;
    }

    console.log(`[도서스킬] ✅ 검증 선택: ${book.title} — ${book.author} (${book.source})`);
    return book;
  }

  return null;
}

async function resolveBookForReview(input = {}) {
  const topicLabel = input.topic ? ` (${input.topic})` : '';
  console.log(`[도서스킬] 도서 후보 검색 시작...${topicLabel}`);
  const reviewedHistory = await loadReviewedBookHistory();
  const canonicalCandidates = await searchCanonicalVerifiedBooks();
  const canonicalBook = await selectVerifiedBookCandidate(canonicalCandidates, reviewedHistory);
  if (canonicalBook) return canonicalBook;
  if (canonicalCandidates.length) {
    console.warn('[도서스킬] canonical 후보가 모두 중복/검증 실패 → 외부 검색 후보로 재시도');
  }

  const searchCandidates = await searchBookCandidates(input);
  return selectVerifiedBookCandidate(searchCandidates, reviewedHistory);
}

module.exports = {
  buildBalancedBookReviewSeeds,
  buildBookReviewQueue,
  buildBookReviewQueueCleanupPlan,
  buildBookReviewQueueDedupeKey,
  buildDiversePreferredBooks,
  calculateReviewDemandBoost,
  enrichBooksWithReviewDemand,
  fetchNaverBookReviewDemand,
  findBookReviewQueueEntryByDedupeKey,
  inferCatalogCategory,
  listBookCatalog,
  listBookReviewQueue,
  loadCatalogBooks,
  loadReviewedBookHistory,
  normalizeReviewedBookKey,
  resolveBookForReview,
  searchBookCandidates,
  searchData4LibraryPopular,
  searchData4LibraryRecommend,
  searchKakaoBook,
  searchOpenLibrary,
  syncPopularBooksToCatalog,
  syncRecommendedBooksToCatalog,
  setBookReviewQueuePgForTest,
  upsertBookReviewQueueEntry,
  updateBookCatalogEntry,
  updateBookReviewQueueEntry,
};
