// @ts-nocheck
'use strict';

const fs = require('fs');
const path = require('path');
const env = require('../../../packages/core/lib/env');
const kst = require('../../../packages/core/lib/kst');

const STRATEGY_DIR = path.join(env.PROJECT_ROOT, 'bots/blog/output/strategy');

function ensureStrategyDir() {
  if (!fs.existsSync(STRATEGY_DIR)) fs.mkdirSync(STRATEGY_DIR, { recursive: true });
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readPreviousStrategyPlan(currentWeekOf) {
  try {
    const candidates = fs.readdirSync(STRATEGY_DIR)
      .filter((name) => /^\d{4}-\d{2}-\d{2}_strategy\.json$/.test(name))
      .sort()
      .reverse();

    for (const name of candidates) {
      const payload = readJsonSafe(path.join(STRATEGY_DIR, name));
      const plan = payload?.plan || null;
      if (!plan?.weekOf || plan.weekOf === currentWeekOf) continue;
      return plan;
    }
    return null;
  } catch {
    return null;
  }
}

function buildHotspotTrend(currentHotspot, previousHotspot, previousWeekOf = null) {
  if (!currentHotspot || !previousHotspot) {
    return {
      status: 'warming_up',
      currentRatio: Number(currentHotspot?.topRatio || 0),
      previousRatio: Number(previousHotspot?.topRatio || 0),
      delta: null,
      previousWeekOf,
    };
  }

  const currentRatio = Number(currentHotspot.topRatio || 0);
  const previousRatio = Number(previousHotspot.topRatio || 0);
  const delta = Number((currentRatio - previousRatio).toFixed(4));
  const sameCategory = currentHotspot.category && previousHotspot.category
    && currentHotspot.category === previousHotspot.category;

  let status = 'stable';
  if (sameCategory && delta <= -0.05) status = 'improving';
  else if (sameCategory && delta >= 0.05) status = 'worsening';
  else if (!sameCategory) status = 'shifted';

  return {
    status,
    currentRatio,
    previousRatio,
    delta,
    previousWeekOf,
    currentCategory: currentHotspot.category || null,
    previousCategory: previousHotspot.category || null,
  };
}

function applyMarketingFeedbackToPlan(plan = {}, marketingDigest = null) {
  if (!marketingDigest || typeof marketingDigest !== 'object') return plan;

  const next = {
    ...plan,
    marketingFeedback: {
      generatedAt: marketingDigest.generatedAt || new Date().toISOString(),
      health: marketingDigest.health || null,
      senseSummary: marketingDigest.senseSummary || null,
      revenueImpactPct: Number(marketingDigest?.revenueCorrelation?.revenueImpactPct || 0),
      snapshotTrend: marketingDigest.snapshotTrend || null,
      autonomySummary: marketingDigest.autonomySummary || null,
    },
  };

  const focus = Array.isArray(next.focus) ? [...next.focus] : [];
  const recommendations = Array.isArray(next.recommendations) ? [...next.recommendations] : [];
  const revenueImpactPct = Number(marketingDigest?.revenueCorrelation?.revenueImpactPct || 0);
  const signalCount = Number(marketingDigest?.senseSummary?.signalCount || 0);
  const topSignalType = String(marketingDigest?.senseSummary?.topSignal?.type || '');
  const topSignalMessage = String(marketingDigest?.senseSummary?.topSignal?.message || '');
  const latestWeakness = String(marketingDigest?.snapshotTrend?.latestWeakness || '');
  const watchCount = Number(marketingDigest?.snapshotTrend?.watchCount || 0);
  const adoptionStatus = String(marketingDigest?.strategyAdoption?.status || '');
  const latestAlignmentHint = String(marketingDigest?.strategyAdoption?.latestAlignmentHint || '');
  const preferredCategory = String(next.preferredCategory || '');

  if (revenueImpactPct < -0.05) {
    focus.unshift('매출 하락 구간용 전환형 주제와 CTA 강화');
    recommendations.unshift('예약 문의, 상담 신청, 무료 체험처럼 자연스러운 전환 CTA를 일반 글 후반부에 더 자주 배치하세요.');
    next.preferredCategory = next.preferredCategory || '홈페이지와App';
  } else if (revenueImpactPct > 0.05) {
    focus.unshift('매출 우세 신호가 있는 포맷 재사용');
    recommendations.unshift('매출 반응이 좋았던 포맷은 제목 패턴과 CTA 위치를 유지한 채 카테고리만 바꿔 재검증하세요.');
  }

  if (topSignalType === 'exam_period') {
    focus.unshift('시험기간 학습 효율형 콘텐츠 비중 확대');
    recommendations.unshift('스터디 루틴, 집중 유지, 좌석 선택, 공부 동선처럼 학습 효율 주제를 우선 노출하세요.');
    next.preferredCategory = '성장과성공';
  }

  if (topSignalType === 'holiday' || /공휴일/.test(topSignalMessage)) {
    recommendations.unshift('공휴일 구간에는 부담이 적은 체크리스트형·가벼운 실전 팁형 콘텐츠를 우선 배치하세요.');
    next.preferredTitlePattern = next.preferredTitlePattern || 'checklist';
  }

  if (latestWeakness === 'title_pattern_bias' || watchCount > 0) {
    recommendations.push('최근 스냅샷 경고가 남아 있어 제목 패턴과 CTA 위치를 동시에 한 번에 바꾸기보다 하나씩만 바꿔 검증하세요.');
  }

  if (signalCount >= 3) {
    recommendations.push('오늘 감지된 운영 신호가 많으니, 실험성 제목보다 독자 문제를 바로 짚는 안정형 제목을 우선 쓰는 편이 좋습니다.');
  }

  if (latestAlignmentHint.startsWith('category_drift:') && preferredCategory) {
    next.preferredCategoryWeightBoost = Math.max(Number(next.preferredCategoryWeightBoost || 0), 6);
    recommendations.unshift(`최근 일반 글이 전략 카테고리에서 벗어나 ${preferredCategory} 회전 가중치를 더 강하게 적용합니다.`);
    focus.unshift(`${preferredCategory} 카테고리 채택률 우선 복구`);
  } else if (adoptionStatus === 'aligned') {
    next.preferredCategoryWeightBoost = 0;
  }

  next.focus = [...new Set(focus.filter(Boolean))];
  next.recommendations = [...new Set(recommendations.filter(Boolean))];
  return next;
}

function buildExecutionDirectives(plan = {}, diagnosis = {}, marketingDigest = null) {
  const revenueImpactPct = Number(marketingDigest?.revenueCorrelation?.revenueImpactPct || 0);
  const topSignalType = String(marketingDigest?.senseSummary?.topSignal?.type || '');
  const preferredCategory = String(plan.preferredCategory || '').trim();

  const isConversionPush = revenueImpactPct < -0.05 || topSignalType === 'exam_period';
  const isAmplifyPush = revenueImpactPct > 0.05;

  const hashtagFocusTags = [];
  if (preferredCategory) hashtagFocusTags.push(`#${preferredCategory.replace(/\s+/g, '')}`);
  if (topSignalType === 'exam_period') {
    hashtagFocusTags.push('#시험기간', '#집중력', '#스터디루틴');
  } else if (topSignalType === 'holiday') {
    hashtagFocusTags.push('#연휴루틴', '#가벼운실천');
  }

  const neighborBase = isConversionPush ? 3 : 2;
  const sympathyBase = isAmplifyPush ? 5 : 3;

  return {
    channelPriority: {
      naverBlog: 'primary',
      instagram: isAmplifyPush ? 'primary' : 'secondary',
      facebook: isConversionPush ? 'secondary' : 'supporting',
    },
    executionTargets: {
      blogRegistrationsPerCycle: 1,
      instagramRegistrationsPerCycle: isAmplifyPush ? 2 : 1,
      facebookRegistrationsPerCycle: isConversionPush ? 2 : 1,
      replyTargetPerCycle: 1,
      neighborCommentTargetPerCycle: neighborBase,
      sympathyTargetPerCycle: sympathyBase,
    },
    titlePolicy: {
      preferredPattern: plan.preferredTitlePattern || null,
      suppressedPattern: plan.suppressedTitlePattern || null,
      tone: isConversionPush ? 'conversion' : isAmplifyPush ? 'amplify' : 'balanced',
      keywordBias: [
        preferredCategory,
        isConversionPush ? '예약' : null,
        isConversionPush ? '전환' : null,
        isAmplifyPush ? '성과' : null,
        isAmplifyPush ? '증가' : null,
      ].filter(Boolean),
    },
    hashtagPolicy: {
      mode: isAmplifyPush ? 'aggressive' : isConversionPush ? 'conversion' : 'balanced',
      focusTags: [...new Set(hashtagFocusTags)],
      platformTags: isAmplifyPush
        ? ['#릴스', '#reels', '#인스타마케팅', '#바이럴']
        : isConversionPush
          ? ['#예약문의', '#상담문의', '#전환콘텐츠']
          : ['#블로그마케팅', '#콘텐츠전략'],
    },
    creativePolicy: {
      imageAggro: isAmplifyPush ? 'high' : isConversionPush ? 'medium' : 'medium',
      reelAggro: isAmplifyPush ? 'high' : isConversionPush ? 'high' : 'balanced',
      hookStyle: isAmplifyPush ? 'scroll_stop' : isConversionPush ? 'problem_first' : 'balanced',
      ctaStyle: isConversionPush ? 'conversion' : isAmplifyPush ? 'engagement' : 'balanced',
      imageDirection: isAmplifyPush
        ? 'strong color contrast, tension, immediate scroll-stopping curiosity'
        : isConversionPush
          ? 'trust-building, concrete value, reservation-oriented payoff'
          : 'premium curiosity with clear business relevance',
    },
  };
}

function createStrategyPlan(diagnosis = {}, options = {}) {
  const topCategory = diagnosis.byCategory?.[0]?.key || null;
  const topPattern = diagnosis.byTitlePattern?.[0]?.key || null;
  const topCategoryPattern =
    diagnosis.primaryWeakness?.category
      ? diagnosis.byCategoryPattern?.find((item) => item?.category === diagnosis.primaryWeakness.category) || null
      : diagnosis.byCategoryPattern?.[0] || null;
  const preferredPatternOrder = ['checklist', 'experience', 'warning', 'trend', 'why'];
  const alternativePatterns = Array.isArray(diagnosis.byTitlePattern)
    ? diagnosis.byTitlePattern
        .map((item) => item?.key)
        .filter(Boolean)
        .filter((key) => key !== topPattern)
    : [];
  const preferredAlternative = preferredPatternOrder
    .find((key) => key !== topPattern && alternativePatterns.includes(key));
  const safePatternFallback = preferredPatternOrder
    .find((key) => key !== topPattern && !alternativePatterns.includes(key));

  const focus = [];
  if (diagnosis.primaryWeakness?.code === 'category_bias' && topCategory) {
    focus.push(`다음 주에는 ${topCategory} 외 카테고리 우선 편성`);
  }
  if (diagnosis.primaryWeakness?.code === 'category_title_pattern_bias' && diagnosis.primaryWeakness?.category) {
    focus.push(`${diagnosis.primaryWeakness.category} 카테고리의 default 제목 패턴 교정`);
  }
  if (diagnosis.primaryWeakness?.code === 'title_pattern_bias' && topPattern) {
    focus.push(`${topPattern} 패턴 비중 축소, 경험형/체크리스트형 강화`);
  }
  if (!focus.length) {
    focus.push('현재 분포 유지, 제목 패턴만 순환 테스트');
  }

  const forcedPreferredPattern =
    (diagnosis.primaryWeakness?.code === 'title_pattern_bias' && topPattern === 'default')
      || (diagnosis.primaryWeakness?.code === 'category_title_pattern_bias' && diagnosis.primaryWeakness?.pattern === 'default')
      ? 'checklist'
      : null;

  const plan = {
    evolvedAt: new Date().toISOString(),
    weekOf: kst.today(),
    weakness: diagnosis.primaryWeakness,
    focus,
    recommendations: diagnosis.recommendations || [],
    preferredCategory:
      diagnosis.primaryWeakness?.code === 'category_title_pattern_bias'
        ? diagnosis.primaryWeakness?.category
        : diagnosis.byCategory?.[1]?.key || diagnosis.byCategory?.[0]?.key || null,
    suppressedCategory:
      diagnosis.primaryWeakness?.code === 'category_title_pattern_bias'
        ? null
        : diagnosis.byCategory?.[0]?.key || null,
    preferredTitlePattern:
      forcedPreferredPattern
      || preferredAlternative
      || safePatternFallback
      || diagnosis.byTitlePattern?.[0]?.key
      || null,
    preferredCategoryWeightBoost: 0,
    suppressedTitlePattern: diagnosis.byTitlePattern?.[0]?.key || null,
    hardSuppressTitlePattern:
      diagnosis.primaryWeakness?.code === 'title_pattern_bias'
      || diagnosis.primaryWeakness?.code === 'category_title_pattern_bias',
    categoryPatternHotspot: topCategoryPattern || null,
  };

  const previousPlan = readPreviousStrategyPlan(plan.weekOf);
  plan.hotspotTrend = buildHotspotTrend(
    plan.categoryPatternHotspot,
    previousPlan?.categoryPatternHotspot || null,
    previousPlan?.weekOf || null,
  );
  plan.executionDirectives = buildExecutionDirectives(plan, diagnosis, options.marketingDigest || null);

  return applyMarketingFeedbackToPlan(plan, options.marketingDigest);
}

async function evolveStrategy(diagnosis = {}, options = {}) {
  const plan = createStrategyPlan(diagnosis, options);
  if (options.dryRun) {
    return {
      saved: false,
      latestPath: null,
      datedPath: null,
      plan,
    };
  }

  ensureStrategyDir();
  const latestPath = path.join(STRATEGY_DIR, 'latest-strategy.json');
  const datedPath = path.join(STRATEGY_DIR, `${kst.today()}_strategy.json`);
  const payload = {
    diagnosis,
    plan,
  };

  fs.writeFileSync(latestPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.writeFileSync(datedPath, JSON.stringify(payload, null, 2), 'utf8');

  return {
    saved: true,
    latestPath,
    datedPath,
    plan,
  };
}

module.exports = {
  evolveStrategy,
  createStrategyPlan,
  applyMarketingFeedbackToPlan,
  buildExecutionDirectives,
};
