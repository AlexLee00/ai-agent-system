// @ts-nocheck
'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const env = require('../../../packages/core/lib/env');

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

module.exports = {
  getVaultLectureContext,
  _testOnly: {
    isVaultContextEnabled,
    buildVaultLectureQuery,
    buildVaultLectureBlock,
  },
};
