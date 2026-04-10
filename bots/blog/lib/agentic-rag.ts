// @ts-nocheck
'use strict';

const richer = require('./richer.ts');

function evaluateSearchResults(episodes = [], posts = [], topic = '') {
  let score = 0;
  const gaps = [];

  if (episodes.length >= 3) score += 0.4;
  else gaps.push('에피소드 부족');

  if (posts.length >= 2) score += 0.3;
  else gaps.push('관련 포스팅 부족');

  if (String(topic || '').trim().length >= 4) score += 0.1;

  const sourceKinds = new Set((episodes || []).map((item) => item?.source).filter(Boolean));
  if (sourceKinds.size >= 2) score += 0.2;
  else if ((episodes || []).length > 0) gaps.push('소스 다양성 부족');

  return {
    sufficient: score >= 0.6,
    score,
    gaps,
  };
}

function reformulateQuery(topic = '', category = 'general', attempt = 0, gaps = []) {
  const base = String(topic || '').trim();
  if (!base) return category === 'lecture' ? 'Node.js 실무 장애 해결 사례' : '실무 적용 사례';

  if (gaps.includes('에피소드 부족')) return `${base} 실무 사례 오류 해결`;
  if (gaps.includes('관련 포스팅 부족')) return `${base} 체크리스트 판단 기준`;
  if (attempt === 0) return `${base} 운영 경험`;
  return `${base} 실제 적용`;
}

async function agenticSearch(topic, category = 'general', maxRetries = 3, currentLectureNum = null) {
  let currentQuery = String(topic || '').trim();
  let best = {
    episodes: [],
    relatedPosts: [],
    quality: 0,
    query: currentQuery,
    attempts: 0,
    gaps: [],
  };

  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const [episodes, relatedPosts] = await Promise.all([
      richer.searchRealExperiences(currentQuery, category),
      richer.searchRelatedPosts(currentQuery, currentLectureNum),
    ]);
    const evaluation = evaluateSearchResults(episodes, relatedPosts, currentQuery);

    if (evaluation.score >= best.quality) {
      best = {
        episodes,
        relatedPosts,
        quality: evaluation.score,
        query: currentQuery,
        attempts: attempt + 1,
        gaps: evaluation.gaps,
      };
    }

    if (evaluation.sufficient) break;
    currentQuery = reformulateQuery(currentQuery, category, attempt, evaluation.gaps);
  }

  console.log(`[AgenticRAG] query="${best.query}" attempts=${best.attempts} quality=${best.quality.toFixed(2)} episodes=${best.episodes.length} posts=${best.relatedPosts.length}`);
  return best;
}

module.exports = {
  agenticSearch,
  evaluateSearchResults,
};
