'use strict';

/**
 * bots/blog/lib/autonomy-gate.ts — 자율 판단 게이트
 *
 * 피드백 루프 ACT 단계: 자동 게시 vs 마스터 검토 판단
 * - 초안 품질 자체 평가 (0~1 점수)
 * - Phase별 임계값으로 자동/검토 분기
 * - 마스터 피드백 패턴 반영
 */

const pgPool = require('../../../packages/core/lib/pg-pool');

const PHASE_THRESHOLDS = {
  1: 0.95,  // Phase 1: 거의 완벽해야 자동 게시
  2: 0.80,  // Phase 2: 80% 이상이면 자동 게시
  3: 0.60,  // Phase 3: 기본 품질만 통과하면 자동 게시
};

/**
 * 현재 자율 Phase 조회
 */
async function getCurrentPhase() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT current_phase FROM blog.autonomy_log
      ORDER BY logged_at DESC LIMIT 1
    `);
    return rows?.[0]?.current_phase || 1;
  } catch {
    return 1;
  }
}

/**
 * 마스터 피드백 패턴 로드 (최근 30일)
 */
async function loadFeedbackPatterns() {
  try {
    const rows = await pgPool.query('blog', `
      SELECT feedback_type, COUNT(*) as count
      FROM blog.master_feedback
      WHERE learned_at >= CURRENT_DATE - 30
      GROUP BY feedback_type
      ORDER BY count DESC
    `);
    return rows || [];
  } catch {
    return [];
  }
}

/**
 * 초안 품질 평가 (0~1)
 */
function evaluatePostQuality(post, feedbackPatterns = []) {
  let score = 1.0;
  const reasons = [];

  // 1. 글자수 검사
  const contentLen = (post.content || '').length;
  if (contentLen < 5000) {
    score -= 0.15;
    reasons.push(`글자수 부족 (${contentLen}자)`);
  }

  // 2. 제목 검사
  if (!post.title || post.title.length < 10) {
    score -= 0.1;
    reasons.push('제목이 짧음');
  }

  // 3. 썸네일 유무
  if (!post.thumbnailPath) {
    score -= 0.1;
    reasons.push('썸네일 없음');
  }

  // 4. 필수 섹션 (FAQ, 인사말, 마무리)
  const content = post.content || '';
  if (!content.includes('FAQ') && !content.includes('자주 묻는')) {
    score -= 0.05;
    reasons.push('FAQ 섹션 없음');
  }

  // 5. 마스터 빈출 수정 패턴 반영
  for (const pattern of feedbackPatterns) {
    if (pattern.feedback_type === 'tone' && pattern.count >= 3) {
      // 톤 수정이 빈번 → 톤 검증 필요
      score -= 0.05;
      reasons.push('톤 수정 빈출 패턴 감지');
    }
    if (pattern.feedback_type === 'structure' && pattern.count >= 3) {
      score -= 0.05;
      reasons.push('구조 수정 빈출 패턴 감지');
    }
  }

  return {
    score: Math.max(0, Math.min(1, score)),
    reasons,
  };
}

/**
 * 자율 판단: 자동 게시 vs 마스터 검토
 *
 * @param {object} post           - { content, title, thumbnailPath, category }
 * @param {object} [qualityExtra] - { seoScore, criticScore } from quality-checker.ts
 */
/**
 * @param {object} post
 * @param {{ seoScore?: number, criticScore?: number }} [qualityExtra]
 */
async function decideAutonomy(post, qualityExtra = {}) {
  const phase = await getCurrentPhase();
  const feedbackPatterns = await loadFeedbackPatterns();
  const evaluation = evaluatePostQuality(post, feedbackPatterns);
  const threshold = PHASE_THRESHOLDS[phase] || 0.95;

  // SEO + 크리틱 점수 통합 (0~1 스케일로 정규화, 각 최대 ±0.05 보정)
  let compositeScore = evaluation.score;
  const compositeReasons = [...evaluation.reasons];

  // @ts-ignore JS checkJs default-param inference is too narrow here
  const seoScore = Number(qualityExtra.seoScore ?? 50);
  // @ts-ignore JS checkJs default-param inference is too narrow here
  const criticScore = Number(qualityExtra.criticScore ?? 50);

  // SEO: 70+ → +0.03, 45 미만 → -0.03
  if (seoScore >= 70)      { compositeScore += 0.03; }
  else if (seoScore < 45)  { compositeScore -= 0.03; compositeReasons.push(`SEO 점수 낮음 (${seoScore})`); }

  // 크리틱: 70+ → +0.03, 50 미만 → -0.05
  if (criticScore >= 70)       { compositeScore += 0.03; }
  else if (criticScore < 50)   { compositeScore -= 0.05; compositeReasons.push(`크리틱 점수 낮음 (${criticScore})`); }

  compositeScore = Math.max(0, Math.min(1, compositeScore));
  const decision = compositeScore >= threshold ? 'auto_publish' : 'master_review';

  return {
    decision,
    phase,
    score: compositeScore,
    baseScore: evaluation.score,
    seoScore,
    criticScore,
    threshold,
    reasons: compositeReasons,
    feedbackPatterns,
  };
}

module.exports = {
  decideAutonomy,
  evaluatePostQuality,
  getCurrentPhase,
  loadFeedbackPatterns,
  PHASE_THRESHOLDS,
};
