'use strict';

const kst = require('../kst');

let explorationIdCounter = 0;

// 탐색 항목 생성
function createExploration(opts) {
  const o = opts || {};
  explorationIdCounter += 1;

  return {
    id: o.id || `explore-${explorationIdCounter}`,
    technology: o.technology || '',
    source: o.source || '',
    status: o.status || 'pending',
    evaluatedAt: kst.datetimeStr(),
    applicability: typeof o.applicability === 'number' ? o.applicability : null,
    risk: o.risk || 'MEDIUM',
    benefit: o.benefit || '',
  };
}

// 기술의 시스템 적용 가능성 평가
function evaluateApplicability(tech, systemContext) {
  if (!tech) {
    console.warn('[skills/skill-explorer] 기술 정보 누락');
    return null;
  }

  const ctx = systemContext || {};
  const teams = Array.isArray(ctx.teams) ? ctx.teams : [];
  const stack = Array.isArray(ctx.stack) ? ctx.stack : [];
  const constraints = Array.isArray(ctx.constraints) ? ctx.constraints : [];

  let score = 0.5; // 기본 점수
  const reasons = [];
  const risks = [];

  // 기존 스택과의 호환성
  const techName = (typeof tech === 'string' ? tech : tech.technology || '').toLowerCase();
  const stackLower = stack.map((s) => s.toLowerCase());

  if (stackLower.some((s) => techName.includes(s) || s.includes(techName))) {
    score += 0.2;
    reasons.push('기존 스택과 호환');
  }

  // 팀 수에 따른 영향도
  if (teams.length > 5) {
    score += 0.1;
    reasons.push('다수 팀에 적용 가능');
  }

  // 제약 사항 확인
  if (constraints.length > 0) {
    score -= 0.1 * Math.min(constraints.length, 3);
    risks.push(`제약 사항 ${constraints.length}건`);
  }

  // 점수 범위 보정
  score = Math.max(0, Math.min(1, Math.round(score * 100) / 100));

  if (reasons.length === 0) reasons.push('기본 평가');

  return { score, reasons, risks };
}

// 우선순위 정렬
function prioritizeExplorations(list) {
  const explorations = Array.isArray(list) ? list.slice() : [];

  return explorations.sort((a, b) => {
    const scoreA = typeof a.applicability === 'number' ? a.applicability : 0;
    const scoreB = typeof b.applicability === 'number' ? b.applicability : 0;
    return scoreB - scoreA; // 높은 점수 우선
  });
}

module.exports = { createExploration, evaluateApplicability, prioritizeExplorations };
