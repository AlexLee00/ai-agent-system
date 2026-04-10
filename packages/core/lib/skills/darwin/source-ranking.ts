// @ts-nocheck
'use strict';

function _toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function _clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function scoreSource(item = {}) {
  const sourceType = String(item.source_type || '').toLowerCase();
  const publisher = String(item.publisher || '').toLowerCase();
  const citations = _toNumber(item.citations, 0);
  const stars = _toNumber(item.stars, 0);
  const recencyDays = _toNumber(item.recency_days, 365);
  const official = !!item.official;

  let score = 5.0;
  const reasons = [];
  const riskFlags = [];

  const typeBonus = {
    paper: 1.7,
    official: 1.8,
    github: 0.8,
    blog: -0.3,
    community: -1.2,
    video: -0.5,
  };
  score += typeBonus[sourceType] || 0;

  if (official) {
    score += 1.4;
    reasons.push('official publisher');
  }

  if (publisher.includes('research') || publisher.includes('openai') || publisher.includes('anthropic') || publisher.includes('microsoft') || publisher.includes('google')) {
    score += 0.8;
    reasons.push('recognized research or vendor source');
  }

  if (sourceType === 'paper') {
    reasons.push('paper source');
    if (citations >= 50) {
      score += 0.8;
      reasons.push('well cited');
    } else if (citations >= 10) {
      score += 0.4;
      reasons.push('cited');
    } else if (citations === 0) {
      riskFlags.push('no citations yet');
    }
  }

  if (sourceType === 'github') {
    if (stars >= 5000) {
      score += 1.0;
      reasons.push('high repo traction');
    } else if (stars >= 500) {
      score += 0.5;
      reasons.push('repo traction');
    } else if (stars < 50) {
      riskFlags.push('low repo traction');
    }
  }

  if (recencyDays <= 30) {
    score += 0.9;
    reasons.push('recent');
  } else if (recencyDays <= 180) {
    score += 0.3;
    reasons.push('moderately recent');
  } else if (recencyDays > 730) {
    score -= 1.0;
    riskFlags.push('stale source');
  }

  if (sourceType === 'community') {
    riskFlags.push('community-only claim');
  }
  if (sourceType === 'blog' && !official) {
    riskFlags.push('non-official blog');
  }

  score = _clamp(Number(score.toFixed(2)), 0, 10);

  let tier = 'D';
  if (score >= 8.0) tier = 'A';
  else if (score >= 6.0) tier = 'B';
  else if (score >= 4.0) tier = 'C';

  return {
    ...item,
    trust_score: score,
    tier,
    reasons,
    risk_flags: riskFlags,
  };
}

function rankSources(items = []) {
  const ranked = (Array.isArray(items) ? items : [])
    .map(scoreSource)
    .sort((a, b) => b.trust_score - a.trust_score);

  return {
    ranked,
    summary: {
      total: ranked.length,
      tierA: ranked.filter((item) => item.tier === 'A').length,
      tierB: ranked.filter((item) => item.tier === 'B').length,
      tierC: ranked.filter((item) => item.tier === 'C').length,
      tierD: ranked.filter((item) => item.tier === 'D').length,
    },
  };
}

module.exports = {
  scoreSource,
  rankSources,
};
