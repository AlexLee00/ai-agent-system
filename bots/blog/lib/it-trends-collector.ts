#!/usr/bin/env node
// @ts-nocheck
'use strict';

const path = require('path');
const env = require('../../../packages/core/lib/env');
const { resolveNaverCredentials } = require('../../../packages/core/lib/news-credentials.legacy.js');
const { classifyTitlePattern } = require('./crank-diagnoser.ts');
const { saveTrendTopics } = require('./blog-v3-unified.ts');

const USER_AGENT = 'ai-agent-blog/1.0 (+https://blog.naver.com/cafe_library)';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_DELAY_MS = 250;
const DEFAULT_LIMIT_PER_SOURCE = 12;
const DEFAULT_IT_KEYWORDS = [
  'AI 개발 자동화',
  'AI 에이전트',
  '개발 생산성',
  '웹앱 UX',
  '클라우드 비용 최적화',
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

function loadItKeywords() {
  try {
    const config = require(path.join(env.PROJECT_ROOT, 'bots/blog/config.json'));
    const configured = config?.runtime_config?.externalLearning?.itKeywords;
    if (Array.isArray(configured) && configured.length) {
      return configured.map((item) => normalizeText(item)).filter(Boolean).slice(0, 12);
    }
  } catch {
    // Config is optional; defaults keep the collector deterministic.
  }
  return DEFAULT_IT_KEYWORDS;
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

function normalizeHnHit(hit = {}, query = '') {
  const title = normalizeText(hit.title || hit.story_title);
  if (!title) return null;
  const points = Number(hit.points || 0);
  const comments = Number(hit.num_comments || 0);
  return {
    source: 'hn',
    title,
    title_pattern: getTitlePattern(title),
    score_signal: {
      points,
      comments,
      score: clampScore(Math.min(100, points / 5 + comments / 2), 45),
    },
    url: hit.url || hit.story_url || (hit.objectID ? `https://news.ycombinator.com/item?id=${hit.objectID}` : ''),
    collected_at: new Date().toISOString(),
    genre: 'it',
    meta: {
      objectId: hit.objectID || null,
      query: query || null,
      createdAt: hit.created_at || null,
    },
  };
}

function normalizeDevToArticle(article = {}) {
  const title = normalizeText(article.title);
  if (!title) return null;
  const reactions = Number(article.positive_reactions_count || 0);
  const comments = Number(article.comments_count || 0);
  return {
    source: 'devto',
    title,
    title_pattern: getTitlePattern(title),
    score_signal: {
      reactions,
      comments,
      score: clampScore(Math.min(100, reactions / 2 + comments * 2), 42),
    },
    url: article.url || '',
    collected_at: new Date().toISOString(),
    genre: 'it',
    meta: {
      publishedAt: article.published_at || null,
      tags: Array.isArray(article.tag_list) ? article.tag_list.slice(0, 8) : [],
    },
  };
}

function normalizeNaverBlogItem(item = {}, keyword = '') {
  const title = normalizeText(item.title);
  if (!title) return null;
  const description = normalizeText(item.description);
  return {
    source: 'naver_it',
    title,
    title_pattern: getTitlePattern(title),
    score_signal: {
      keyword,
      score: 74,
    },
    url: item.link || '',
    collected_at: new Date().toISOString(),
    genre: 'it',
    meta: {
      keyword,
      description: description.slice(0, 240),
      bloggerName: normalizeText(item.bloggername || ''),
      postDate: item.postdate || null,
    },
  };
}

async function collectHnFrontPage(options = {}) {
  const limit = boundedNumber(options.limit, DEFAULT_LIMIT_PER_SOURCE, 1, 50);
  const data = await fetchJson('https://hn.algolia.com/api/v1/search?tags=front_page', options);
  return (data.hits || []).slice(0, limit).map((hit) => normalizeHnHit(hit)).filter(Boolean);
}

async function collectHnKeywordStories(options = {}) {
  const keywords = (options.keywords || loadItKeywords()).slice(0, boundedNumber(options.keywordLimit, 3, 1, 10));
  const limit = boundedNumber(options.limit, DEFAULT_LIMIT_PER_SOURCE, 1, 50);
  const items = [];
  for (const keyword of keywords) {
    const url = `https://hn.algolia.com/api/v1/search?tags=story&query=${encodeURIComponent(keyword)}`;
    const data = await fetchJson(url, options).catch(() => ({ hits: [] }));
    items.push(...(data.hits || []).slice(0, Math.max(1, Math.ceil(limit / keywords.length))).map((hit) => normalizeHnHit(hit, keyword)).filter(Boolean));
    await sleep(options.delayMs ?? DEFAULT_DELAY_MS);
  }
  return items.slice(0, limit);
}

async function collectDevToTop(options = {}) {
  const limit = boundedNumber(options.limit, DEFAULT_LIMIT_PER_SOURCE, 1, 50);
  const url = `https://dev.to/api/articles?top=7&per_page=${limit}`;
  const data = await fetchJson(url, options).catch(() => []);
  return (Array.isArray(data) ? data : []).slice(0, limit).map(normalizeDevToArticle).filter(Boolean);
}

async function collectNaverBlogIt(options = {}) {
  const keywords = (options.keywords || loadItKeywords()).slice(0, boundedNumber(options.keywordLimit, 4, 1, 12));
  const limit = boundedNumber(options.limit, DEFAULT_LIMIT_PER_SOURCE, 1, 50);
  const { clientId, clientSecret } = await resolveNaverCredentials({ timeoutMs: options.secretTimeoutMs || 3000 }).catch(() => ({ clientId: '', clientSecret: '' }));
  if (!clientId || !clientSecret) {
    return { skipped: true, reason: 'missing_naver_credentials', items: [] };
  }

  const items = [];
  for (const keyword of keywords) {
    const url = `https://openapi.naver.com/v1/search/blog.json?query=${encodeURIComponent(keyword)}&display=${Math.min(10, limit)}&sort=sim`;
    const data = await fetchJson(url, {
      ...options,
      headers: {
        'X-Naver-Client-Id': clientId,
        'X-Naver-Client-Secret': clientSecret,
      },
    }).catch(() => ({ items: [] }));
    items.push(...(data.items || []).slice(0, Math.max(1, Math.ceil(limit / keywords.length))).map((item) => normalizeNaverBlogItem(item, keyword)).filter(Boolean));
    await sleep(options.delayMs ?? DEFAULT_DELAY_MS);
  }
  return { skipped: false, reason: null, items: items.slice(0, limit) };
}

function fixtureItTrendItems() {
  return [
    normalizeHnHit({ objectID: '1', title: 'SQLite on the edge for small teams', points: 320, num_comments: 88, url: 'https://example.com/sqlite-edge' }),
    normalizeNaverBlogItem({ title: 'AI 에이전트 도입 전 확인할 5가지 기준', link: 'https://blog.naver.com/example/1', description: '운영 비용과 검증 절차를 함께 봐야 합니다.', bloggername: 'sample' }, 'AI 에이전트'),
    normalizeDevToArticle({ title: 'How to keep your TypeScript monorepo fast', positive_reactions_count: 96, comments_count: 14, url: 'https://dev.to/example/ts-monorepo', tag_list: ['typescript'] }),
  ].filter(Boolean);
}

function dedupeItems(items = []) {
  const seen = new Set();
  const deduped = [];
  for (const item of items || []) {
    const key = `${item.source}:${normalizeText(item.url || item.title).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function buildItTrendTopics(items = []) {
  return (items || []).map((item) => ({
    topic_ko: item.title,
    category: item.source === 'naver_it' ? 'IT정보와분석' : '최신IT트렌드',
    keywords: [item.source, item.title_pattern?.label].filter(Boolean),
    trend_score: clampScore(item.score_signal?.score, 55),
    korea_relevance: item.source === 'naver_it' ? 90 : 72,
    is_book_topic: false,
    reason: `${item.source} IT external learning candidate`,
    meta: {
      ...item.meta,
      source: item.source,
      title: item.title,
      title_pattern: item.title_pattern,
      score_signal: item.score_signal,
      url: item.url,
      collected_at: item.collected_at,
      genre: 'it',
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

async function saveItTrendTopics(items = [], options = {}) {
  const grouped = groupBySource(items);
  const result = {};
  for (const [source, sourceItems] of Object.entries(grouped)) {
    result[source] = await saveTrendTopics(buildItTrendTopics(sourceItems), source, {
      dryRun: options.dryRun !== false,
      addedBy: 'it-trends-collector',
    });
  }
  return result;
}

async function runItTrendsCollector(options = {}) {
  const source = String(options.source || 'all');
  let items = [];
  const sourceStatus = {};

  if (options.fixture) {
    items = fixtureItTrendItems();
    sourceStatus.fixture = { ok: true, items: items.length };
  } else {
    if (source === 'all' || source === 'hn') {
      const hn = [
        ...await collectHnFrontPage(options).catch(() => []),
        ...await collectHnKeywordStories(options).catch(() => []),
      ];
      items.push(...hn);
      sourceStatus.hn = { ok: hn.length > 0, items: hn.length };
      await sleep(options.delayMs ?? DEFAULT_DELAY_MS);
    }
    if (source === 'all' || source === 'naver_it') {
      const naver = await collectNaverBlogIt(options);
      items.push(...(naver.items || []));
      sourceStatus.naver_it = { ok: !naver.skipped, skipped: !!naver.skipped, reason: naver.reason || null, items: (naver.items || []).length };
      await sleep(options.delayMs ?? DEFAULT_DELAY_MS);
    }
    if (source === 'all' || source === 'devto') {
      const devto = await collectDevToTop(options).catch(() => []);
      items.push(...devto);
      sourceStatus.devto = { ok: devto.length > 0, items: devto.length };
    }
  }

  const deduped = dedupeItems(items).slice(0, boundedNumber(options.totalLimit, 40, 1, 200));
  const topics = buildItTrendTopics(deduped);
  const saved = options.save
    ? await saveItTrendTopics(deduped, { dryRun: options.dryRun !== false })
    : null;
  return {
    ok: true,
    dryRun: options.dryRun !== false,
    genre: 'it',
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
  DEFAULT_IT_KEYWORDS,
  USER_AGENT,
  buildItTrendTopics,
  collectDevToTop,
  collectHnFrontPage,
  collectHnKeywordStories,
  collectNaverBlogIt,
  dedupeItems,
  fixtureItTrendItems,
  getTitlePattern,
  loadItKeywords,
  normalizeDevToArticle,
  normalizeHnHit,
  normalizeNaverBlogItem,
  runItTrendsCollector,
  saveItTrendTopics,
};
