#!/usr/bin/env node
// @ts-nocheck
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { fetchHubSecrets } = require('../../../packages/core/lib/hub-client');
const { resolveNaverCredentials } = require('../../../packages/core/lib/news-credentials.legacy.js');
const { classifyTitlePattern } = require('./crank-diagnoser.ts');
const { saveTrendTopics } = require('./blog-v3-unified.ts');
const { fetchAladinBooksByQueryType, fetchAladinWebBestsellers } = require('./bestseller-fetcher.ts');

const USER_AGENT = 'ai-agent-blog/1.0 (+https://blog.naver.com/cafe_library)';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_DELAY_MS = 250;
const DEFAULT_LIMIT_PER_SOURCE = 12;
const BOOK_CATEGORIES = [
  { id: 170, name: '자기계발' },
  { id: 351, name: '경제/경영' },
  { id: 656, name: 'IT/컴퓨터' },
  { id: 798, name: '인문' },
];
const ALADIN_QUERY_TYPES = [
  { queryType: 'BlogBest', source: 'aladin_blogbest', label: '블로거 베스트' },
  { queryType: 'ItemEditorChoice', source: 'aladin_editor_choice', label: '편집자 추천' },
  { queryType: 'ItemNewSpecial', source: 'aladin_new_special', label: '신간 주목' },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function normalizeText(value = '') {
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

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safe));
}

function getTitlePattern(title) {
  const pattern = classifyTitlePattern(title || '');
  return { key: pattern.key, label: pattern.label };
}

function clampScore(value, fallback = 50) {
  return Math.max(0, Math.min(100, Math.round(Number.isFinite(Number(value)) ? Number(value) : fallback)));
}

function buildStructureHint({ title = '', description = '' } = {}) {
  const text = `${title}\n${description}`;
  return {
    titlePattern: getTitlePattern(title),
    hasReviewCue: /서평|리뷰|후기|읽고|독서|책/i.test(text),
    hasListCue: /\d+\s*(가지|개|단계|문장|질문)/.test(text),
    descriptionLength: normalizeText(description).length,
  };
}

async function fetchJson(url, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), boundedNumber(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1000, 60_000));
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`http_${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadAladinTtbKey() {
  const blogSecrets = await fetchHubSecrets('blog', 3000, { silentStatuses: [404] }).catch(() => null);
  return blogSecrets?.ALADIN_TTB_KEY || process.env.ALADIN_TTB_KEY || '';
}

function normalizeAladinBook(book = {}, context = {}) {
  const bookTitle = normalizeText(book.title);
  if (!bookTitle) return null;
  const score = clampScore((Number(book.customerReviewRank || 0) * 7) + Math.min(Number(book.salesPoint || 0) / 1000, 20), 58);
  return {
    source: context.source || 'aladin_blogbest',
    book_title: bookTitle,
    review_title: `${bookTitle} 서평 포인트`,
    title_pattern: getTitlePattern(bookTitle),
    structure_hint: buildStructureHint({ title: bookTitle, description: book.description || '' }),
    url: book.link || '',
    collected_at: new Date().toISOString(),
    genre: 'book',
    score_signal: {
      rating: Number(book.customerReviewRank || 0),
      salesPoint: Number(book.salesPoint || 0),
      score,
    },
    meta: {
      queryType: context.queryType || null,
      queryTypeLabel: context.label || null,
      category: context.categoryName || book.categoryName || null,
      author: book.author || null,
      publisher: book.publisher || null,
      isbn13: book.isbn13 || null,
      pubDate: book.pubDate || null,
      cover: book.cover || null,
    },
  };
}

function normalizeNaverBookReview(item = {}, book = {}) {
  const reviewTitle = normalizeText(item.title);
  if (!reviewTitle) return null;
  const description = normalizeText(item.description);
  return {
    source: 'naver_book_review',
    book_title: normalizeText(book.book_title || book.title || ''),
    review_title: reviewTitle,
    title_pattern: getTitlePattern(reviewTitle),
    structure_hint: buildStructureHint({ title: reviewTitle, description }),
    url: item.link || '',
    collected_at: new Date().toISOString(),
    genre: 'book',
    score_signal: {
      query: book.book_title || book.title || '',
      score: 72,
    },
    meta: {
      description: description.slice(0, 260),
      bloggerName: normalizeText(item.bloggername || ''),
      postDate: item.postdate || null,
      seedSource: book.source || null,
    },
  };
}

async function collectAladinReviewBooks(options = {}) {
  const ttbKey = options.ttbKey || await loadAladinTtbKey();
  const perQueryLimit = boundedNumber(options.limit, DEFAULT_LIMIT_PER_SOURCE, 1, 30);

  if (!ttbKey) {
    const fallbackBooks = await fetchAladinWebBestsellers(0, '도서', perQueryLimit).catch(() => []);
    return {
      skipped: false,
      reason: 'web_fallback',
      items: fallbackBooks
        .map((book) => normalizeAladinBook(book, {
          source: 'aladin_blogbest',
          queryType: 'BlogBest',
          label: '블로거 베스트',
          categoryName: book.categoryName || '도서',
        }))
        .filter(Boolean),
    };
  }

  const categoryLimit = boundedNumber(options.categoryLimit, 2, 1, BOOK_CATEGORIES.length);
  const items = [];
  for (const query of ALADIN_QUERY_TYPES) {
    for (const category of BOOK_CATEGORIES.slice(0, categoryLimit)) {
      const maxResults = Math.max(1, Math.ceil(perQueryLimit / categoryLimit));
      const books = await fetchAladinBooksByQueryType({
        categoryId: category.id,
        ttbKey,
        maxResults,
        queryType: query.queryType,
      }).catch(() => []);
      items.push(...books.map((book) => normalizeAladinBook(book, { ...query, categoryName: category.name })).filter(Boolean));
      await sleep(options.delayMs ?? DEFAULT_DELAY_MS);
    }
  }
  return { skipped: false, reason: null, items: dedupeItems(items).slice(0, perQueryLimit * ALADIN_QUERY_TYPES.length) };
}

async function collectNaverBookReviews(seedBooks = [], options = {}) {
  const limit = boundedNumber(options.naverLimit, DEFAULT_LIMIT_PER_SOURCE, 1, 50);
  const seeds = (seedBooks || []).filter((book) => book.book_title || book.title).slice(0, boundedNumber(options.seedLimit, 6, 1, 20));
  const { clientId, clientSecret } = await resolveNaverCredentials({ timeoutMs: options.secretTimeoutMs || 3000 }).catch(() => ({ clientId: '', clientSecret: '' }));
  if (!clientId || !clientSecret) return { skipped: true, reason: 'missing_naver_credentials', items: [] };

  const items = [];
  for (const seed of seeds) {
    const query = `${seed.book_title || seed.title} 서평`;
    const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(query)}&display=${Math.min(10, limit)}&sort=sim`;
    const data = await fetchJson(url, {
      ...options,
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
      },
    }).catch(() => ({ items: [] }));
    items.push(...(data.items || []).slice(0, Math.max(1, Math.ceil(limit / Math.max(1, seeds.length)))).map((item) => normalizeNaverBookReview(item, seed)).filter(Boolean));
    await sleep(options.delayMs ?? DEFAULT_DELAY_MS);
  }
  return { skipped: false, reason: null, items: dedupeItems(items).slice(0, limit) };
}

function fixtureBookReviewItems() {
  const aladin = normalizeAladinBook({
    title: '일의 격',
    author: '신수정',
    publisher: '턴어라운드',
    isbn13: '9791190000000',
    pubDate: '2026-01-01',
    customerReviewRank: 9,
    salesPoint: 32000,
    link: 'https://www.aladin.co.kr/shop/wproduct.aspx?ItemId=1',
  }, { source: 'aladin_blogbest', queryType: 'BlogBest', label: '블로거 베스트', categoryName: '자기계발' });
  const review = normalizeNaverBookReview({
    title: '일의 격을 읽고 남긴 3가지 질문',
    link: 'https://blog.naver.com/example/2',
    description: '책의 핵심을 일상 업무 기준으로 바꾸는 서평입니다.',
    bloggername: 'sample',
  }, aladin);
  return [aladin, review].filter(Boolean);
}

function dedupeItems(items = []) {
  const seen = new Set();
  const deduped = [];
  for (const item of items || []) {
    const key = `${item.source}:${normalizeText(item.url || item.review_title || item.book_title).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function buildBookTrendTopics(items = []) {
  return (items || []).map((item) => ({
    topic_ko: item.review_title || item.book_title,
    category: '도서리뷰',
    keywords: [item.book_title, item.title_pattern?.label].filter(Boolean),
    trend_score: clampScore(item.score_signal?.score, 55),
    korea_relevance: item.source === 'naver_book_review' ? 88 : 82,
    is_book_topic: true,
    reason: `${item.source} book external learning candidate`,
    meta: {
      ...item.meta,
      source: item.source,
      book_title: item.book_title,
      review_title: item.review_title,
      title_pattern: item.title_pattern,
      structure_hint: item.structure_hint,
      score_signal: item.score_signal,
      url: item.url,
      collected_at: item.collected_at,
      genre: 'book',
    },
  }));
}

function groupBySource(items = []) {
  return items.reduce((acc, item) => {
    const source = item.source || 'unknown';
    if (!acc[source]) acc[source] = [];
    acc[source].push(item);
    return acc;
  }, {});
}

async function saveBookTrendTopics(items = [], options = {}) {
  const grouped = groupBySource(items);
  const result = {};
  for (const [source, sourceItems] of Object.entries(grouped)) {
    result[source] = await saveTrendTopics(buildBookTrendTopics(sourceItems), source, {
      dryRun: options.dryRun !== false,
      addedBy: 'book-review-collector',
    });
  }
  return result;
}

async function runBookReviewCollector(options = {}) {
  let items = [];
  const sourceStatus = {};
  if (options.fixture) {
    items = fixtureBookReviewItems();
    sourceStatus.fixture = { ok: true, items: items.length };
  } else {
    const aladin = await collectAladinReviewBooks(options);
    items.push(...(aladin.items || []));
    sourceStatus.aladin = { ok: !aladin.skipped, skipped: !!aladin.skipped, reason: aladin.reason || null, items: (aladin.items || []).length };

    const naver = await collectNaverBookReviews(aladin.items || [], options);
    items.push(...(naver.items || []));
    sourceStatus.naver_book_review = { ok: !naver.skipped, skipped: !!naver.skipped, reason: naver.reason || null, items: (naver.items || []).length };
  }

  const deduped = dedupeItems(items).slice(0, boundedNumber(options.totalLimit, 40, 1, 200));
  const topics = buildBookTrendTopics(deduped);
  const saved = options.save
    ? await saveBookTrendTopics(deduped, { dryRun: options.dryRun !== false })
    : null;
  return {
    ok: true,
    dryRun: options.dryRun !== false,
    genre: 'book',
    sourceStatus,
    collected: deduped.length,
    bySource: Object.fromEntries(Object.entries(groupBySource(deduped)).map(([key, value]) => [key, value.length])),
    items: deduped,
    topics,
    saved,
    safety: {
      livePublishImpact: false,
      commentImpact: false,
      dbWriteRequiresSaveAndNoDryRun: true,
      secretsRedacted: true,
    },
  };
}

module.exports = {
  ALADIN_QUERY_TYPES,
  BOOK_CATEGORIES,
  buildBookTrendTopics,
  buildStructureHint,
  collectAladinReviewBooks,
  collectNaverBookReviews,
  dedupeItems,
  fixtureBookReviewItems,
  normalizeAladinBook,
  normalizeNaverBookReview,
  runBookReviewCollector,
  saveBookTrendTopics,
};
