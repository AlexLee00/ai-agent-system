'use strict';

/**
 * section-ratio.js — 섹션별 글자수 동적 배분
 *
 * 핵심 원칙:
 *   기존 섹션: 베이스 ±20% 랜덤 변동 (서로 독립)
 *   보너스 인사이트: 기존 축소 없이 총량 순수 증가
 *
 *   보너스 0개: ~9,000자 (±20%)
 *   보너스 1개: ~9,500자 (+500자)
 *   보너스 2개: ~10,000자 (+1,000자)
 */

// ── 베이스 글자수 ────────────────────────────────────────────────

const POS_BASE_CHARS = {
  summary:       150,
  greeting:      350,
  tech_briefing: 1200,
  insight_1:     550,
  theory:        2300,
  insight_2:     550,
  code:          2300,
  insight_3:     550,
  cafe:          500,
  insight_4:     300,
  faq:           850,
  closing:       400,
};

const GEMS_BASE_CHARS = {
  summary:   150,
  greeting:  400,
  trend:     1000,
  insight_1: 500,
  body_1:    1800,
  insight_2: 500,
  body_2:    1800,
  insight_3: 500,
  cafe:      400,
  insight_4: 300,
  faq:       700,
  closing:   350,
};

const STAR_BASE_CHARS = {
  card_1:    200,
  card_2:    200,
  card_3:    200,
  insight_1: 150,
  caption:   200,
};

const BONUS_BASE = { pos: 500, gems: 500, star: 250 };

// ── 섹션 레이블 ──────────────────────────────────────────────────

const SECTION_LABELS = {
  summary:       '[핵심 요약 3줄]',
  greeting:      '[승호아빠 인사말]',
  tech_briefing: '[최신 기술 브리핑]',
  theory:        '[강의 - 이론]',
  code:          '[실무 - 코드 및 아키텍처]',
  cafe:          '[에러 탐지 신경망과 환경의 역학]',
  faq:           '[AEO FAQ]',
  closing:       '[마무리 인사 + 해시태그]',
  trend:         '[최신 트렌드 분석]',
  body_1:        '[본론 1]',
  body_2:        '[본론 2]',
  card_1:        '[인스타 카드 1]',
  card_2:        '[인스타 카드 2]',
  card_3:        '[인스타 카드 3]',
  caption:       '[캡션 + 해시태그]',
  insight_1:     '[전문가의 실무 인사이트 ①]',
  insight_2:     '[전문가의 실무 인사이트 ②]',
  insight_3:     '[전문가의 실무 인사이트 ③]',
  insight_4:     '[전문가의 실무 인사이트 ④]',
};

// ── 핵심 함수 ────────────────────────────────────────────────────

/**
 * 섹션별 글자수 계산
 * 보너스 추가 시 기존 섹션 축소 없이 총량 증가
 *
 * @param {'pos'|'gems'|'star'} botType
 * @param {Array}  bonusInsights — selectBonusInsights() 결과
 * @param {number} [jitter=0.20] — ±변동 범위 (0.20 = ±20%)
 * @returns {{ charCounts, totalChars, baseTotal }}
 */
function calculateSectionChars(botType, bonusInsights = [], jitter = 0.20) {
  const baseMap = botType === 'pos'  ? { ...POS_BASE_CHARS }
                : botType === 'gems' ? { ...GEMS_BASE_CHARS }
                :                      { ...STAR_BASE_CHARS };

  const charCounts = {};

  // 기존 섹션: 베이스 ±jitter 독립 변동
  for (const [section, base] of Object.entries(baseMap)) {
    const factor = 1 + (Math.random() * 2 - 1) * jitter;
    charCounts[section] = Math.round(base * factor);
  }

  // 보너스 섹션: 순수 추가 (기존 축소 없음)
  const bonusBase = BONUS_BASE[botType] || 500;
  for (const bonus of bonusInsights) {
    const factor = 1 + (Math.random() * 2 - 1) * jitter;
    charCounts[`bonus_${bonus.id}`] = Math.round(bonusBase * factor);
  }

  const totalChars = Object.values(charCounts).reduce((s, v) => s + v, 0);
  const baseTotal  = Object.values(baseMap).reduce((s, v) => s + v, 0);

  return { charCounts, totalChars, baseTotal };
}

/**
 * LLM 지시용 글자수 문자열 생성
 *
 * @param {object} charCounts — calculateSectionChars() 결과
 * @param {'pos'|'gems'|'star'} botType
 * @param {Array}  bonusInsights
 * @returns {string}
 */
function buildCharCountInstruction(charCounts, botType, bonusInsights = []) {
  const labels = { ...SECTION_LABELS };
  bonusInsights.forEach(b => { labels[`bonus_${b.id}`] = b.title; });

  const total = Object.values(charCounts).reduce((s, v) => s + v, 0);
  const lines = [
    '★★★ 섹션별 글자수 (반드시 준수) ★★★',
    `총 글자수: 약 ${total}자`,
    '',
  ];

  for (const [section, chars] of Object.entries(charCounts)) {
    const label    = labels[section] || `[${section}]`;
    const isBonus  = section.startsWith('bonus_');
    lines.push(`  ${label}: ~${chars}자${isBonus ? ' ★추가 섹션' : ''}`);
  }

  lines.push('');
  lines.push('각 섹션 ±10% 범위 준수. 보너스 추가 시 기존 섹션 줄이지 말 것.');

  return lines.join('\n');
}

module.exports = { calculateSectionChars, buildCharCountInstruction };
