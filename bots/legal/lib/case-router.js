'use strict';

/**
 * case-router.js — 감정 사건 유형 분류 + 에이전트 라우팅 규칙
 *
 * justin.js의 classifyCase를 분리하여 재사용 가능하게 구성.
 * 유형별로 어떤 에이전트를 활성화할지 정의.
 */

const CASE_TYPES = {
  copyright:    '저작권 침해',
  defect:       '소프트웨어 하자',
  contract:     '계약 위반',
  trade_secret: '영업비밀 침해',
  other:        '기타',
};

// 유형별 에이전트 라우팅 설정
const AGENT_ROUTES = {
  copyright: {
    required: ['briefing', 'claim', 'defense', 'lens', 'garam', 'atlas', 'quill', 'balance'],
    optional: ['contro'],
    description: '소스코드 유사도 분석이 핵심 — lens 필수',
  },
  defect: {
    required: ['briefing', 'claim', 'defense', 'garam', 'quill', 'balance'],
    optional: ['lens', 'atlas'],
    description: 'SW 기능 하자 분석 중심 — 현장실사 필수',
  },
  contract: {
    required: ['briefing', 'claim', 'defense', 'contro', 'garam', 'quill', 'balance'],
    optional: ['lens', 'atlas'],
    description: '계약서 검토(contro) + 이행 여부 분석',
  },
  trade_secret: {
    required: ['briefing', 'claim', 'defense', 'lens', 'garam', 'quill', 'balance'],
    optional: ['atlas', 'contro'],
    description: '코드 유출 경로 분석 + 유사도 검증',
  },
  other: {
    required: ['briefing', 'garam', 'quill', 'balance'],
    optional: ['claim', 'defense', 'lens', 'atlas', 'contro'],
    description: '일반 SW 분쟁 — 사건 특성에 따라 에이전트 추가',
  },
};

/**
 * 감정 유형 유효성 검증
 */
function isValidType(type) {
  return type in CASE_TYPES;
}

/**
 * 유형명 → 한국어 라벨
 */
function typeLabel(type) {
  return CASE_TYPES[type] || '알 수 없음';
}

/**
 * 감정 유형에 따른 에이전트 라우팅 반환
 * @returns {{ required: string[], optional: string[], description: string }}
 */
function getAgentRoute(type) {
  return AGENT_ROUTES[type] || AGENT_ROUTES.other;
}

/**
 * 문서 텍스트·감정항목 키워드 기반 유형 추론 (LLM 없이 빠른 1차 분류)
 * 최종 분류는 justin.js → classifyCase (LLM) 사용
 */
function inferTypeFromKeywords(documentText = '', appraisalItems = []) {
  const text = (documentText + ' ' + appraisalItems.join(' ')).toLowerCase();

  if (/저작권|복제|표절|소스코드\s*유사/.test(text)) return 'copyright';
  if (/영업비밀|유출|기밀|trade.?secret/.test(text)) return 'trade_secret';
  if (/하자|결함|오작동|미완성|불이행/.test(text)) return 'defect';
  if (/계약|용역|개발비|납품|지체상금/.test(text)) return 'contract';
  return 'other';
}

module.exports = {
  CASE_TYPES,
  AGENT_ROUTES,
  isValidType,
  typeLabel,
  getAgentRoute,
  inferTypeFromKeywords,
};
