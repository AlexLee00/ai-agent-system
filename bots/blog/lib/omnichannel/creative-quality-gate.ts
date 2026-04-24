'use strict';

/**
 * bots/blog/lib/omnichannel/creative-quality-gate.ts
 *
 * 발행 전 크리에이티브 품질 게이트.
 * 점수 기준 통과/차단/재생성 결정 — 승인 버튼 없음.
 */

const pgPool = require('../../../../packages/core/lib/pg-pool');

const GATE_THRESHOLD_PASS = 60;   // 60점 이상 → 통과
const GATE_THRESHOLD_BLOCK = 30;  // 30점 미만 → 차단 (자동 재생성 시도 후 eval-case)

const BANNED_PHRASES = [
  '무조건', '100% 보장', '절대 실패 없는', '확실히 돈', '부자 되는',
  '기적', '마법처럼', '클릭하면 즉시', '즉시 수익',
];

/**
 * 브랜드 일치 점수 (0~20)
 */
function scoreBrand({ caption = '', hashtags = [], brandAxis = '' }) {
  let score = 10;
  const text = `${caption} ${(hashtags || []).join(' ')}`.toLowerCase();

  if (brandAxis === 'cafe_library' || brandAxis === 'mixed') {
    if (text.includes('커피랑도서관') || text.includes('cafe_library')) score += 5;
    if (text.includes('분당') || text.includes('서현')) score += 3;
    if (text.includes('스터디카페') || text.includes('스터디룸')) score += 2;
  }
  if (brandAxis === 'seungho_dad' || brandAxis === 'mixed') {
    if (text.includes('승호아빠') || text.includes('seungho')) score += 5;
    if (text.includes('자동화') || text.includes('개발')) score += 3;
    if (text.includes('ai') || text.includes('블로그')) score += 2;
  }

  return Math.min(score, 20);
}

/**
 * 훅 강도 점수 (0~20)
 */
function scoreHook({ caption = '', title = '' }) {
  let score = 8;
  const first = (caption || '').split('\n')[0] || title || '';

  const hookSignals = ['?', '!', '📚', '☕', '🤖', '⚡', '💡', '🔥'];
  for (const sig of hookSignals) {
    if (first.includes(sig)) { score += 2; break; }
  }

  const hookWords = ['비밀', '방법', '이유', '달라', '공개', '실패', '성공', '놀라운', '진짜'];
  for (const w of hookWords) {
    if (first.includes(w)) { score += 3; break; }
  }

  if (first.length >= 15 && first.length <= 60) score += 5;
  else if (first.length > 0 && first.length < 15) score += 2;

  return Math.min(score, 20);
}

/**
 * CTA 일치 점수 (0~20)
 */
function scoreCta({ cta = '', caption = '', objective = '' }) {
  let score = 8;
  const text = `${cta} ${caption}`.toLowerCase();

  const ctaSignals = ['▶', '→', '링크', '예약', '확인', '클릭', '방문', '팔로우', '구독'];
  for (const sig of ctaSignals) {
    if (text.includes(sig)) { score += 4; break; }
  }

  const objCtaMap = {
    conversion: ['예약', '지금', '바로', '링크', '방문'],
    engagement: ['댓글', '의견', '어떻게', '여러분'],
    awareness: ['소개', '안녕', '저는', '입니다'],
    retention: ['감사', '오늘도', '매일'],
    brand_trust: ['믿어', '투명', '공개', '과정'],
  };
  const targetWords = objCtaMap[objective] || [];
  for (const w of targetWords) {
    if (text.includes(w)) { score += 5; break; }
  }

  return Math.min(score, 20);
}

/**
 * 정책 준수 점수 (0~20) — 과장/오해/민감 표현 방지
 */
function scorePolicy({ caption = '', title = '' }) {
  let score = 20;
  const text = `${caption} ${title}`;
  for (const phrase of BANNED_PHRASES) {
    if (text.includes(phrase)) {
      score -= 10;
    }
  }
  return Math.max(score, 0);
}

/**
 * API readiness 점수 (0~20)
 */
function scoreApiReadiness({ platform, assetRefs = null, config = {} }) {
  let score = 10;

  // 인증 확인
  if (config.accessToken) score += 5;
  if (platform.startsWith('instagram') && config.igUserId) score += 3;
  if (platform === 'facebook_page' && config.pageId) score += 3;

  // 인스타 릴스는 asset 필요
  if (platform === 'instagram_reel') {
    if (assetRefs?.reelPublicUrl) score += 2;
    else score -= 5;
  }

  return Math.min(Math.max(score, 0), 20);
}

/**
 * 시각 품질 점수 (0~20) — 릴스/이미지 규격
 * (실제 파일 분석 없이 metadata 기반 추정)
 */
function scoreVisual({ platform, assetRefs = null }) {
  let score = 15;

  if (platform === 'instagram_reel') {
    if (!assetRefs?.reelPath && !assetRefs?.reelPublicUrl) score -= 8;
    if (assetRefs?.coverPath || assetRefs?.coverPublicUrl) score += 3;
    if (assetRefs?.qaSheetPath) score += 2;
  } else if (platform === 'facebook_page') {
    score = 15; // 텍스트 전용도 허용
  }

  return Math.min(Math.max(score, 0), 20);
}

/**
 * 품질 게이트 실행.
 * @returns {{ gateResult, scoreTotal, scores, reasons, passed, recoverable }}
 */
function runCreativeQualityGate({ variant, config = {} }) {
  const {
    platform = '',
    caption = '',
    title = '',
    cta = '',
    hashtags = [],
    asset_refs: assetRefs = null,
    campaign_id: campaignId,
    brand_axis: brandAxis = '',
    objective = '',
  } = variant || {};

  const brandScore = scoreBrand({ caption, hashtags, brandAxis });
  const hookScore = scoreHook({ caption, title });
  const ctaScore = scoreCta({ cta, caption, objective });
  const policyScore = scorePolicy({ caption, title });
  const visualScore = scoreVisual({ platform, assetRefs });
  const apiReadinessScore = scoreApiReadiness({ platform, assetRefs, config });

  const scoreTotal =
    brandScore + hookScore + ctaScore + policyScore + visualScore + apiReadinessScore;

  const passedReasons = [];
  const blockedReasons = [];
  const recoverableReasons = [];

  if (brandScore >= 15) passedReasons.push('브랜드 키워드 충분');
  else if (brandScore < 8) blockedReasons.push('브랜드 키워드 부족');
  else recoverableReasons.push('브랜드 키워드 보강 권장');

  if (hookScore >= 15) passedReasons.push('훅 강도 양호');
  else if (hookScore < 8) recoverableReasons.push('첫 문장 훅 강화 필요');

  if (policyScore < 10) blockedReasons.push('과장/금지 표현 포함');
  else passedReasons.push('정책 준수');

  // 인스타 릴스는 공개 URL이 없으면 반드시 recoverable (토큰 점수와 무관)
  if (platform === 'instagram_reel' && !assetRefs?.reelPublicUrl && !assetRefs?.reelPath) {
    recoverableReasons.push('릴스 공개 URL 미준비 — prepare:instagram-media 필요');
  } else if (platform === 'instagram_reel' && apiReadinessScore < 10) {
    recoverableReasons.push('릴스 공개 URL 미준비 — prepare:instagram-media 필요');
  }

  let gateResult = 'passed';
  if (blockedReasons.length > 0 || scoreTotal < GATE_THRESHOLD_BLOCK) {
    gateResult = 'blocked';
  } else if (recoverableReasons.length > 0 || scoreTotal < GATE_THRESHOLD_PASS) {
    gateResult = 'recoverable';
  }

  return {
    gateResult,
    scoreTotal,
    scores: { brandScore, hookScore, ctaScore, policyScore, visualScore, apiReadinessScore },
    reasons: { passed: passedReasons, blocked: blockedReasons, recoverable: recoverableReasons },
    passed: gateResult === 'passed' || gateResult === 'recoverable',
    recoverable: gateResult === 'recoverable',
  };
}

/**
 * 품질 게이트 실행 후 DB에 저장.
 */
async function evaluateAndSaveQuality({ variant, config = {}, dryRun = false }) {
  const result = runCreativeQualityGate({ variant, config });
  const { gateResult, scoreTotal, scores, reasons } = result;

  console.log(
    `[quality-gate] variant=${variant?.variant_id || '?'} score=${scoreTotal} result=${gateResult}`
  );

  if (!dryRun && variant?.variant_id) {
    await pgPool.query('blog', `
      INSERT INTO blog.marketing_creative_quality
        (variant_id, score_total, brand_score, hook_score, cta_score,
         visual_score, policy_score, api_readiness_score, reasons, gate_result)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
      ON CONFLICT (variant_id) DO UPDATE SET
        score_total = EXCLUDED.score_total,
        brand_score = EXCLUDED.brand_score,
        hook_score = EXCLUDED.hook_score,
        cta_score = EXCLUDED.cta_score,
        visual_score = EXCLUDED.visual_score,
        policy_score = EXCLUDED.policy_score,
        api_readiness_score = EXCLUDED.api_readiness_score,
        reasons = EXCLUDED.reasons,
        gate_result = EXCLUDED.gate_result,
        evaluated_at = NOW()
    `, [
      variant.variant_id,
      scoreTotal,
      scores.brandScore,
      scores.hookScore,
      scores.ctaScore,
      scores.visualScore,
      scores.policyScore,
      scores.apiReadinessScore,
      JSON.stringify(reasons),
      gateResult,
    ]).catch((e) => console.warn('[quality-gate] DB 저장 실패:', e.message));

    // variant 상태도 갱신
    await pgPool.query('blog', `
      UPDATE blog.marketing_platform_variants
      SET quality_score = $2, quality_status = $3, updated_at = NOW()
      WHERE variant_id = $1
    `, [
      variant.variant_id,
      scoreTotal,
      gateResult === 'passed' ? 'passed'
        : gateResult === 'recoverable' ? 'pending'
        : 'blocked',
    ]).catch(() => {});
  }

  return result;
}

module.exports = {
  runCreativeQualityGate,
  evaluateAndSaveQuality,
  GATE_THRESHOLD_PASS,
  GATE_THRESHOLD_BLOCK,
};
