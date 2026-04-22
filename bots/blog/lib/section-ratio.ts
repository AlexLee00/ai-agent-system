'use strict';

const { getBlogSectionRatioRuntimeConfig } = require('./runtime-config.ts');
const { loadStrategyBundle, normalizeExecutionDirectives } = require('./strategy-loader.ts');

type BonusInsight = {
  id: string;
  title: string;
};

const POS_BASE_CHARS = {
  summary: 150,
  greeting: 350,
  tech_briefing: 1200,
  insight_1: 550,
  theory: 2300,
  insight_2: 550,
  code: 2300,
  insight_3: 550,
  cafe: 500,
  insight_4: 300,
  faq: 850,
  closing: 400,
};

const GEMS_BASE_CHARS = {
  summary: 150,
  greeting: 400,
  trend: 1000,
  insight_1: 500,
  body_1: 2000,
  insight_2: 500,
  body_2: 2000,
  insight_3: 500,
  cafe: 400,
  insight_4: 300,
  faq: 700,
  closing: 350,
};

const STAR_BASE_CHARS = {
  card_1: 200,
  card_2: 200,
  card_3: 200,
  insight_1: 150,
  caption: 200,
};

const BONUS_BASE = { pos: 500, gems: 500, star: 250 };

const SECTION_LABELS = {
  summary: '[핵심 요약 3줄]',
  greeting: '[승호아빠 인사말]',
  tech_briefing: '[최신 기술 브리핑]',
  theory: '[강의 - 이론]',
  code: '[실무 - 코드 및 아키텍처]',
  cafe: '[에러 탐지 신경망과 환경의 역학]',
  faq: '[AEO FAQ]',
  closing: '[마무리 인사 + 해시태그]',
  trend: '[최신 트렌드 분석]',
  body_1: '[본론 1]',
  body_2: '[본론 2]',
  card_1: '[인스타 카드 1]',
  card_2: '[인스타 카드 2]',
  card_3: '[인스타 카드 3]',
  caption: '[캡션 + 해시태그]',
  insight_1: '[전문가의 실무 인사이트 ①]',
  insight_2: '[전문가의 실무 인사이트 ②]',
  insight_3: '[전문가의 실무 인사이트 ③]',
  insight_4: '[전문가의 실무 인사이트 ④]',
};

function clampChars(value, minimum = 120) {
  return Math.max(minimum, Math.round(Number(value) || minimum));
}

function getPriorityMultiplier(priority = 'secondary') {
  if (priority === 'primary') return 1.15;
  if (priority === 'supporting') return 0.92;
  return 1.0;
}

function applyMultiplier(baseChars = {}, keys = [], multiplier = 1) {
  for (const key of keys) {
    if (typeof baseChars[key] === 'number') {
      baseChars[key] = clampChars(baseChars[key] * multiplier);
    }
  }
}

function applyStrategySectionOverrides(botType, baseChars = {}, bonusBase = 0) {
  const plan = loadStrategyBundle().plan;
  const directives = normalizeExecutionDirectives(plan);
  const adjusted = { ...baseChars };
  let nextBonusBase = bonusBase;

  const tone = directives.titlePolicy.tone;
  const ctaStyle = directives.creativePolicy.ctaStyle;
  const imageAggro = directives.creativePolicy.imageAggro;
  const reelAggro = directives.creativePolicy.reelAggro;

  if (botType === 'pos') {
    if (tone === 'conversion' || ctaStyle === 'conversion') {
      applyMultiplier(adjusted, ['summary', 'faq', 'closing'], 1.18);
      applyMultiplier(adjusted, ['theory', 'code'], 0.92);
      nextBonusBase = clampChars(nextBonusBase * 1.08, 180);
    } else if (tone === 'amplify') {
      applyMultiplier(adjusted, ['greeting', 'tech_briefing', 'cafe'], 1.12);
      applyMultiplier(adjusted, ['summary', 'closing'], 0.95);
      nextBonusBase = clampChars(nextBonusBase * 1.1, 180);
    }
  }

  if (botType === 'gems') {
    if (tone === 'conversion' || ctaStyle === 'conversion') {
      applyMultiplier(adjusted, ['summary', 'faq', 'closing'], 1.2);
      applyMultiplier(adjusted, ['body_1', 'body_2'], 0.9);
      nextBonusBase = clampChars(nextBonusBase * 1.05, 180);
    } else if (tone === 'amplify') {
      applyMultiplier(adjusted, ['trend', 'insight_1', 'insight_2', 'insight_3'], 1.14);
      applyMultiplier(adjusted, ['faq'], 0.92);
      nextBonusBase = clampChars(nextBonusBase * 1.12, 180);
    }
  }

  if (botType === 'star') {
    const instagramMultiplier = getPriorityMultiplier(directives.channelPriority.instagram);
    applyMultiplier(adjusted, ['card_1', 'card_2', 'card_3', 'caption'], instagramMultiplier);
    if (imageAggro === 'high') {
      applyMultiplier(adjusted, ['card_1', 'card_2', 'card_3'], 1.12);
    } else if (imageAggro === 'low') {
      applyMultiplier(adjusted, ['card_1', 'card_2', 'card_3'], 0.9);
    }

    if (reelAggro === 'high' || tone === 'amplify') {
      applyMultiplier(adjusted, ['insight_1', 'caption'], 1.18);
      nextBonusBase = clampChars(nextBonusBase * 1.15, 120);
    } else if (tone === 'conversion') {
      applyMultiplier(adjusted, ['caption'], 1.2);
      applyMultiplier(adjusted, ['insight_1'], 0.94);
      nextBonusBase = clampChars(nextBonusBase * 1.05, 120);
    }
  }

  return { baseChars: adjusted, bonusBase: nextBonusBase };
}

function getSectionRatioDefaults(botType) {
  if (botType === 'pos') {
    return {
      jitter: 0.20,
      baseChars: POS_BASE_CHARS,
      bonusBase: BONUS_BASE.pos,
    };
  }
  if (botType === 'gems') {
    return {
      jitter: 0.20,
      baseChars: GEMS_BASE_CHARS,
      bonusBase: BONUS_BASE.gems,
    };
  }
  return {
    jitter: 0.20,
    baseChars: STAR_BASE_CHARS,
    bonusBase: BONUS_BASE.star,
  };
}

function getSectionRatioConfig(botType) {
  const runtime = getBlogSectionRatioRuntimeConfig() || {};
  const defaults = getSectionRatioDefaults(botType);
  const scoped = botType === 'pos'
    ? (runtime.lecture || {})
    : botType === 'gems'
      ? (runtime.general || {})
      : (runtime.shortform || {});

  const strategyAdjusted = applyStrategySectionOverrides(
    botType,
    {
      ...defaults.baseChars,
      ...(scoped.baseChars || {}),
    },
    Number(scoped.bonusBase ?? defaults.bonusBase)
  );

  return {
    jitter: Number(scoped.jitter ?? defaults.jitter),
    baseChars: strategyAdjusted.baseChars,
    bonusBase: strategyAdjusted.bonusBase,
  };
}

function calculateSectionChars(botType: 'pos' | 'gems' | 'star', bonusInsights: BonusInsight[] = [], jitter) {
  const config = getSectionRatioConfig(botType);
  const baseMap = { ...config.baseChars } as Record<string, number>;
  const jitterValue = typeof jitter === 'number' ? jitter : config.jitter;

  const charCounts: Record<string, number> = {};

  for (const [section, base] of Object.entries(baseMap)) {
    const factor = 1 + (Math.random() * 2 - 1) * jitterValue;
    charCounts[section] = Math.round(Number(base) * factor);
  }

  const bonusBase = config.bonusBase || BONUS_BASE[botType] || 500;
  for (const bonus of bonusInsights) {
    const factor = 1 + (Math.random() * 2 - 1) * jitterValue;
    charCounts[`bonus_${bonus.id}`] = Math.round(bonusBase * factor);
  }

  const totalChars = Object.values(charCounts).reduce((sum, value) => Number(sum) + Number(value), 0);
  const baseTotal = Object.values(baseMap).reduce((sum, value) => Number(sum) + Number(value), 0);

  return { charCounts, totalChars, baseTotal };
}

function buildCharCountInstruction(charCounts: Record<string, number>, _botType: 'pos' | 'gems' | 'star', bonusInsights: BonusInsight[] = []) {
  const labels = { ...SECTION_LABELS } as Record<string, string>;
  bonusInsights.forEach((bonus) => { labels[`bonus_${bonus.id}`] = bonus.title; });

  const total = Object.values(charCounts).reduce((sum, value) => sum + value, 0);
  const lines = [
    '★★★ 섹션별 글자수 (반드시 준수) ★★★',
    `총 글자수: 약 ${total}자`,
    '',
  ];

  for (const [section, chars] of Object.entries(charCounts)) {
    const label = labels[section] || `[${section}]`;
    const isBonus = section.startsWith('bonus_');
    lines.push(`  ${label}: ~${chars}자${isBonus ? ' ★추가 섹션' : ''}`);
  }

  lines.push('');
  lines.push('각 섹션 ±10% 범위 준수. 보너스 추가 시 기존 섹션 줄이지 말 것.');

  return lines.join('\n');
}

module.exports = { getSectionRatioConfig, calculateSectionChars, buildCharCountInstruction };
