// @ts-nocheck
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const env = require('../../../packages/core/lib/env');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { isExcludedReferencePost } = require('./reference-exclusions.ts');

const DEFAULT_TOP_K = 4;
const DEFAULT_MIN_SIMILARITY = 0.55;
const DEFAULT_TIMEOUT_MS = 2500;

function isVaultContextEnabled() {
  return process.env.BLOG_VAULT_CONTEXT_ENABLED !== 'false';
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  const safeValue = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safeValue));
}

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function includesQueryPart(container = '', candidate = '') {
  const normalizedContainer = ` ${normalizeText(container).toLowerCase()} `;
  const normalizedCandidate = ` ${normalizeText(candidate).toLowerCase()} `;
  return normalizedCandidate.trim() !== '' && normalizedContainer.includes(normalizedCandidate);
}

function joinIdempotentQueryParts(values = []) {
  let parts = [];
  for (const value of values) {
    const part = normalizeText(value);
    if (!part || parts.some((existing) => includesQueryPart(existing, part))) continue;
    parts = parts.filter((existing) => !includesQueryPart(part, existing));
    parts.push(part);
  }
  return parts.join(' ');
}

function buildVaultLectureQuery(input = {}) {
  const keywords = Array.isArray(input.curriculumKeywords)
    ? input.curriculumKeywords
    : [];
  const parts = [
    input.seriesName,
    input.lectureNumber ? `${input.lectureNumber}강` : '',
    input.lectureTitle,
    ...keywords,
  ]
    .map((item) => normalizeText(item))
    .filter(Boolean);
  return [...new Set(parts)].join(' ');
}

function truncate(value = '', max = 180) {
  const text = normalizeText(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function formatSimilarity(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '';
  return ` / 유사도 ${numeric.toFixed(2)}`;
}

function buildVaultLectureBlock(results = []) {
  const rows = (results || []).slice(0, 3).map((item, index) => {
    const title = truncate(item.title || `관련 강의 ${index + 1}`, 72);
    const preview = truncate(item.contentPreview || '', 180);
    const similarity = formatSimilarity(item.similarity);
    return `- ${title}${similarity}${preview ? `: ${preview}` : ''}`;
  });
  if (!rows.length) return '';
  return [
    '[지난 강의 연계]',
    '아래는 시그마 대도서관에서 찾은 과거 블로그 맥락이다. 이미 발행된 내용과 자연스럽게 연결하되, 사실로 확인되지 않은 링크나 수치는 만들지 말라.',
    ...rows,
  ].join('\n');
}

function normalizeLectureNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function buildVaultRelatedQuery(input = {}) {
  const keywords = Array.isArray(input.curriculumKeywords)
    ? input.curriculumKeywords
    : [];
  return joinIdempotentQueryParts([
    input.seriesName,
    input.currentLectureNum ? `${input.currentLectureNum}강` : '',
    input.topic,
    input.postType,
    ...keywords,
  ]);
}

function buildVaultRelatedPosts(results = [], input = {}) {
  const currentLectureNum = normalizeLectureNumber(input.currentLectureNum);
  const seen = new Set();
  return (results || [])
    .map((item) => {
      const meta = item.meta || {};
      const lectureNumber = normalizeLectureNumber(
        meta.lecture_number || meta.lectureNumber || meta.number
      );
      const title = truncate(item.title || meta.title || '관련 포스팅', 72);
      const summary = truncate(item.contentPreview || meta.summary || '', 140);
      return {
        title,
        summary,
        meta,
        lectureNumber,
        source: 'vault',
        similarity: Number(item.similarity || 0),
      };
    })
    .filter((item) => item.title && item.summary)
    .filter((item) => !currentLectureNum || !item.lectureNumber || item.lectureNumber < currentLectureNum)
    .filter((item) => {
      const key = `${item.title}|${item.summary}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 3);
}

function extractVaultPostFilename(result = {}) {
  const meta = result.meta || {};
  return normalizeText(meta.filename || meta.fileName || meta.file_path || meta.filePath || '');
}

function extractVaultPostId(result = {}) {
  const meta = result.meta || {};
  const numeric = Number(meta.post_id || meta.postId || meta.blog_post_id || meta.blogPostId);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

async function filterPublishedVaultBlogResults(results = []) {
  const rows = Array.isArray(results) ? results : [];
  if (!rows.length) return [];

  const filenames = [...new Set(rows.map(extractVaultPostFilename).filter(Boolean))];
  const postIds = [...new Set(rows.map(extractVaultPostId).filter(Boolean))];
  if (!filenames.length && !postIds.length) return [];

  const publishedRows = await pgPool.query('blog', `
    SELECT id, title, metadata->>'filename' AS filename, metadata
    FROM blog.posts
    WHERE status = 'published'
      AND COALESCE(NULLIF(metadata->>'exclude_from_reference', '')::boolean, false) = false
      AND (
        id = ANY($1::int[])
        OR metadata->>'filename' = ANY($2::text[])
      )
  `, [postIds, filenames]);
  const publishedList = Array.isArray(publishedRows) ? publishedRows : (publishedRows?.rows || []);
  const publishedIds = new Set(
    publishedList
      .filter((row) => !isExcludedReferencePost(row))
      .map((row) => Number(row.id))
      .filter((id) => Number.isFinite(id) && id > 0)
  );
  const publishedFilenames = new Set(
    publishedList
      .filter((row) => !isExcludedReferencePost(row))
      .map((row) => normalizeText(row.filename))
      .filter(Boolean)
  );

  return rows.filter((row) => {
    const postId = extractVaultPostId(row);
    const filename = extractVaultPostFilename(row);
    return (postId && publishedIds.has(postId)) || (filename && publishedFilenames.has(filename));
  });
}

async function loadSearchVault(deps = {}) {
  if (typeof deps.searchVault === 'function') return deps.searchVault;
  const modulePath = path.join(env.PROJECT_ROOT, 'bots/sigma/vault/vault-search.ts');
  const mod = await import(pathToFileURL(modulePath).href);
  return mod.searchVault || mod.default;
}

function withTimeout(promise, timeoutMs) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, results: [], warning: 'vault_context_timeout' }), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function getVaultLectureContext(input = {}, deps = {}) {
  if (!isVaultContextEnabled()) {
    return { enabled: false, ok: true, block: '', results: [], warning: 'disabled' };
  }

  const query = buildVaultLectureQuery(input);
  if (!query) {
    return { enabled: true, ok: true, block: '', results: [], warning: 'query_empty' };
  }

  const topK = Math.floor(boundedNumber(input.topK, DEFAULT_TOP_K, 1, 10));
  const minSimilarity = boundedNumber(input.minSimilarity, DEFAULT_MIN_SIMILARITY, -1, 1);
  const timeoutMs = Math.floor(boundedNumber(input.timeoutMs, DEFAULT_TIMEOUT_MS, 250, 10_000));

  try {
    const searchVault = await loadSearchVault(deps);
    const report = await withTimeout(searchVault(query, {
      topK,
      sourceKinds: ['blo'],
      minSimilarity,
    }), timeoutMs);
    const results = Array.isArray(report?.results) ? report.results : [];
    return {
      enabled: true,
      ok: report?.ok !== false,
      query,
      block: buildVaultLectureBlock(results),
      results,
      warning: report?.warning || null,
    };
  } catch (error) {
    return {
      enabled: true,
      ok: false,
      query,
      block: '',
      results: [],
      warning: error?.message || String(error),
    };
  }
}

async function getVaultRelatedPosts(input = {}, deps = {}) {
  if (!isVaultContextEnabled()) {
    return { enabled: false, ok: true, query: '', relatedPosts: [], results: [], warning: 'disabled' };
  }

  const query = buildVaultRelatedQuery(input);
  if (!query) {
    return { enabled: true, ok: true, query: '', relatedPosts: [], results: [], warning: 'query_empty' };
  }

  const topK = Math.floor(boundedNumber(input.topK, DEFAULT_TOP_K + 2, 1, 10));
  const minSimilarity = boundedNumber(input.minSimilarity, 0.45, -1, 1);
  const timeoutMs = Math.floor(boundedNumber(input.timeoutMs, DEFAULT_TIMEOUT_MS, 250, 10_000));

  try {
    const searchVault = await loadSearchVault(deps);
    const report = await withTimeout(searchVault(query, {
      topK,
      sourceKinds: ['blo'],
      minSimilarity,
    }), timeoutMs);
    const results = Array.isArray(report?.results) ? report.results : [];
    const publishedResults = await filterPublishedVaultBlogResults(results);
    return {
      enabled: true,
      ok: report?.ok !== false,
      query,
      relatedPosts: buildVaultRelatedPosts(publishedResults, input),
      results: publishedResults,
      warning: report?.warning || null,
    };
  } catch (error) {
    return {
      enabled: true,
      ok: false,
      query,
      relatedPosts: [],
      results: [],
      warning: error?.message || String(error),
    };
  }
}

module.exports = {
  getVaultLectureContext,
  getVaultRelatedPosts,
  _testOnly: {
    isVaultContextEnabled,
    buildVaultLectureQuery,
    buildVaultLectureBlock,
    buildVaultRelatedQuery,
    buildVaultRelatedPosts,
    filterPublishedVaultBlogResults,
  },
};
