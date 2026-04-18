'use strict';

function normalizeTitle(text = '') {
  return String(text || '')
    .replace(/^\[[^\]]+\]\s*/, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeTokens(text = '') {
  return normalizeTitle(text)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
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
  const latestRecentTitle = recentTitles[0] || '';

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
    const titleTopicOverlap = tokenOverlapRatio(recentTitle, topic);
    const titleQuestionOverlap = tokenOverlapRatio(recentTitle, question);
    const titleDiffOverlap = tokenOverlapRatio(recentTitle, diff);
    return titleTopicOverlap >= 0.34 || titleQuestionOverlap >= 0.34 || titleDiffOverlap >= 0.4;
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
  normalizeTokens,
  similarity,
  tokenOverlapRatio,
  isTooCloseToRecentTitle,
  mergeRecentTitles,
};
