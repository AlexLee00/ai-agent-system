'use strict';

function normalizeTitle(text = '') {
  return String(text || '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function extractCategoryPrefix(text = '') {
  const match = String(text || '').trim().match(/^\[([^\]]+)\]/);
  return match ? String(match[1] || '').trim() : '';
}

function normalizeTokens(text = '') {
  return normalizeTitle(text)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

const STRUCTURAL_PHRASES = [
  '먼저 확인할',
  '체크리스트',
  '운영 비용',
  '운영 기준',
  '선택 기준',
  '적용 기준',
  '중요한 이유',
  '다시 중요한 이유',
  '가장 먼저',
  '바로 적용',
  '실무 기준',
];

function extractStructuralPhrases(text = '') {
  const normalized = normalizeTitle(text);
  return STRUCTURAL_PHRASES.filter((phrase) => normalized.includes(normalizeTitle(phrase)));
}

function leadingTokenSignature(text = '', count = 4) {
  return normalizeTokens(text).slice(0, count).join(' ');
}

function toBigrams(text = '') {
  const normalized = normalizeTitle(text).replace(/\s+/g, '');
  const set = new Set();
  for (let i = 0; i < normalized.length - 1; i += 1) {
    set.add(normalized.slice(i, i + 2));
  }
  return set;
}

function similarity(a, b) {
  const first = toBigrams(a);
  const second = toBigrams(b);
  if (!first.size || !second.size) return 0;
  let intersection = 0;
  for (const item of first) {
    if (second.has(item)) intersection += 1;
  }
  const union = new Set([...first, ...second]).size;
  return union ? intersection / union : 0;
}

function tokenOverlapRatio(a = '', b = '') {
  const first = new Set(normalizeTokens(a));
  const second = new Set(normalizeTokens(b));
  if (!first.size || !second.size) return 0;
  let intersection = 0;
  for (const token of first) {
    if (second.has(token)) intersection += 1;
  }
  return intersection / Math.max(first.size, second.size);
}

function isTooCloseToRecentTitle(candidate, recentTitles = []) {
  if (!recentTitles.length) return false;

  const title = typeof candidate === 'string' ? candidate : String(candidate?.title || '');
  const topic = typeof candidate === 'string' ? '' : String(candidate?.topic || '');
  const question = typeof candidate === 'string' ? '' : String(candidate?.question || '');
  const diff = typeof candidate === 'string' ? '' : String(candidate?.diff || '');
  const category = typeof candidate === 'string' ? extractCategoryPrefix(title) : String(candidate?.category || extractCategoryPrefix(title) || '').trim();
  const latestRecentTitle = recentTitles[0] || '';
  const candidateStructure = new Set(extractStructuralPhrases(title));
  const candidateLeading = leadingTokenSignature(title);

  if (recentTitles.some((recentTitle) => similarity(recentTitle, title) > 0.4)) {
    return true;
  }

  if (latestRecentTitle) {
    const latestSimilarity = similarity(latestRecentTitle, title);
    const latestTokenOverlap = tokenOverlapRatio(latestRecentTitle, title);
    const topicOverlap = tokenOverlapRatio(latestRecentTitle, topic);
    if (latestSimilarity >= 0.28) return true;
    if (latestTokenOverlap >= 0.45) return true;
    if (topicOverlap >= 0.5) return true;
  }

  return recentTitles.some((recentTitle) => {
    const recentCategory = extractCategoryPrefix(recentTitle);
    const sameCategory = category && recentCategory && category === recentCategory;
    const titleTopicOverlap = tokenOverlapRatio(recentTitle, topic);
    const titleQuestionOverlap = tokenOverlapRatio(recentTitle, question);
    const titleDiffOverlap = tokenOverlapRatio(recentTitle, diff);
    const titleTokenOverlap = tokenOverlapRatio(recentTitle, title);
    const sharedStructure = extractStructuralPhrases(recentTitle).filter((phrase) => candidateStructure.has(phrase));
    const recentLeading = leadingTokenSignature(recentTitle);

    if (titleTopicOverlap >= 0.34 || titleQuestionOverlap >= 0.34 || titleDiffOverlap >= 0.4) return true;
    if (sameCategory && titleTokenOverlap >= 0.38) return true;
    if (sameCategory && sharedStructure.length >= 2 && titleTokenOverlap >= 0.25) return true;
    if (sameCategory && candidateLeading && recentLeading && candidateLeading === recentLeading) return true;
    if (sameCategory && sharedStructure.includes('먼저 확인할') && titleTokenOverlap >= 0.2) return true;
    return false;
  });
}

function mergeRecentTitles(...titleGroups) {
  const seen = new Set();
  const merged = [];
  for (const group of titleGroups) {
    for (const rawTitle of Array.isArray(group) ? group : []) {
      const title = String(rawTitle || '').trim();
      if (!title) continue;
      const key = normalizeTitle(title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(title);
    }
  }
  return merged;
}

module.exports = {
  normalizeTitle,
  extractCategoryPrefix,
  normalizeTokens,
  similarity,
  tokenOverlapRatio,
  extractStructuralPhrases,
  isTooCloseToRecentTitle,
  mergeRecentTitles,
};
