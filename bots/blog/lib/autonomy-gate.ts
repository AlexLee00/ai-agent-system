'use strict';

/**
 * bots/blog/lib/autonomy-gate.ts — 자율 판단 게이트
 *
 * 피드백 루프 ACT 단계: 자동 게시 vs 가드 게시 판단
 * - 초안 품질 자체 평가 (0~1 점수)
 * - Phase별 임계값으로 자동/검토 분기
 * - 운영 피드백 패턴 반영
 */

const pgPool = require('../../../packages/core/lib/pg-pool');

const PHASE_THRESHOLDS = {
  1: 0.95,  // Phase 1: 거의 완벽해야 자동 게시
  2: 0.80,  // Phase 2: 80% 이상이면 자동 게시
  3: 0.60,  // Phase 3: 기본 품질만 통과하면 자동 게시
};

const HARD_HOLD_MIN_CONTENT = 2500;

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
 * 운영 피드백 패턴 로드 (최근 30일)
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

  // 5. 최근 수정/운영 패턴 반영
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

function buildRuntimeThresholdAdjustment(runtimeContext = {}) {
  let delta = 0;
  const reasons = [];
  const signalCount = Number(runtimeContext.signalCount || 0);
  const topSignalType = String(runtimeContext.topSignalType || '').trim();
  const revenueImpactPct = Number(runtimeContext.revenueImpactPct || 0);
  const guardedDominant = runtimeContext.guardedDominant === true;

  if (signalCount > 0) {
    delta -= 0.02;
    reasons.push('운영 신호가 살아 있어 자율 발행 표본을 더 축적하도록 기준을 약간 완화합니다.');
  }

  if (guardedDominant) {
    delta -= 0.03;
    reasons.push('최근 guarded publish 비중이 높아 hard hold보다 guarded lane 표본 축적을 우선합니다.');
  }

  if (topSignalType === 'revenue_anomaly' || topSignalType === 'revenue_decline' || Math.abs(revenueImpactPct) >= 0.05) {
    delta -= 0.02;
    reasons.push('매출/전환 신호가 움직이는 구간이라 멈추기보다 가드형 자동 발행으로 반응을 계속 수집합니다.');
  }

  return {
    delta: Number(delta.toFixed(4)),
    reasons,
  };
}

/**
 * 자율 판단: 자동 게시 vs 가드 게시
 *
 * @param {object} post           - { content, title, thumbnailPath, category }
 * @param {object} [qualityExtra] - { seoScore, criticScore } from quality-checker.ts
 */
/**
 * @param {object} post
 * @param {{ seoScore?: number, criticScore?: number }} [qualityExtra]
 */
async function decideAutonomy(post, qualityExtra = {}, runtimeContext = {}) {
  const phase = await getCurrentPhase();
  const feedbackPatterns = await loadFeedbackPatterns();
  const evaluation = evaluatePostQuality(post, feedbackPatterns);
  const threshold = PHASE_THRESHOLDS[phase] || 0.95;
  const runtimeAdjustment = buildRuntimeThresholdAdjustment(runtimeContext);
  const effectiveThreshold = Math.max(0.45, Math.min(0.98, threshold + Number(runtimeAdjustment.delta || 0)));

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
  const hardHoldReasons = [];
  const title = String(post?.title || '').trim();
  const content = String(post?.content || '').trim();
  if (!title || title.length < 6) {
    hardHoldReasons.push('제목 품질이 너무 낮아 자동 발행을 보류합니다.');
  }
  if (!content || content.length < HARD_HOLD_MIN_CONTENT) {
    hardHoldReasons.push(`본문이 ${HARD_HOLD_MIN_CONTENT}자 미만이라 품질 보강 전 자동 발행을 보류합니다.`);
  }

  let decision = 'auto_publish';
  let executionLane = 'normal';
  if (hardHoldReasons.length > 0) {
    decision = 'quality_hold';
    executionLane = 'hold';
    compositeReasons.push(...hardHoldReasons);
  } else if (compositeScore < effectiveThreshold) {
    decision = 'auto_publish_guarded';
    executionLane = 'guarded';
    compositeReasons.push('점수가 임계값보다 낮아도 가드 레인으로 축소 자동 발행합니다.');
  }
  compositeReasons.push(...runtimeAdjustment.reasons);

  return {
    decision,
    executionLane,
    phase,
    score: compositeScore,
    baseScore: evaluation.score,
    seoScore,
    criticScore,
    threshold: effectiveThreshold,
    baseThreshold: threshold,
    thresholdAdjustment: Number(runtimeAdjustment.delta || 0),
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
