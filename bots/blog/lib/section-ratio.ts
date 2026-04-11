'use strict';

const { getBlogSectionRatioRuntimeConfig } = require('./runtime-config.ts');

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

  return {
    jitter: Number(scoped.jitter ?? defaults.jitter),
    baseChars: {
      ...defaults.baseChars,
      ...(scoped.baseChars || {}),
    },
    bonusBase: Number(scoped.bonusBase ?? defaults.bonusBase),
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
