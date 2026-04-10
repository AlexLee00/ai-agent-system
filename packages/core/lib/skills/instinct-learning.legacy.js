'use strict';

const kst = require('../kst');

let instinctIdCounter = 0;

// 인스턴트 생성
function createInstinct(opts) {
  const o = opts || {};
  instinctIdCounter += 1;

  return {
    id: o.id || `instinct-${instinctIdCounter}`,
    pattern: o.pattern || '',
    action: o.action || '',
    confidence: typeof o.confidence === 'number' ? Math.min(1, Math.max(0, o.confidence)) : 0.5,
    source: o.source || '',
    createdAt: kst.datetimeStr(),
    successes: 0,
    failures: 0,
  };
}

// 신뢰도 업데이트
function updateConfidence(instinct, outcome) {
  if (!instinct) {
    console.warn('[skills/instinct-learning] 인스턴트 누락');
    return null;
  }

  const updated = { ...instinct };

  if (outcome === 'success' || outcome === true) {
    updated.confidence = Math.min(1.0, (updated.confidence || 0) + 0.05);
    updated.successes = (updated.successes || 0) + 1;
  } else {
    updated.confidence = Math.max(0.0, (updated.confidence || 0) - 0.1);
    updated.failures = (updated.failures || 0) + 1;
  }

  updated.confidence = Math.round(updated.confidence * 100) / 100;
  return updated;
}

// 활성 인스턴트 목록 (신뢰도 기준)
function getActiveInstincts(minConfidence, instincts) {
  const list = Array.isArray(instincts) ? instincts : [];
  const threshold = typeof minConfidence === 'number' ? minConfidence : 0.5;

  return list.filter((inst) => inst && typeof inst.confidence === 'number' && inst.confidence >= threshold);
}

// 현재 상황에 맞는 인스턴트 검색
function matchInstinct(context, instincts) {
  if (!context || !Array.isArray(instincts) || instincts.length === 0) return null;

  const contextStr = typeof context === 'string' ? context.toLowerCase() : JSON.stringify(context).toLowerCase();

  for (const inst of instincts) {
    if (!inst || !inst.pattern) continue;
    const patternStr = inst.pattern.toLowerCase();
    // 패턴 키워드가 컨텍스트에 포함되어 있으면 매칭
    const keywords = patternStr.split(/\s+/).filter((w) => w.length > 2);
    const matchCount = keywords.filter((kw) => contextStr.includes(kw)).length;
    if (keywords.length > 0 && matchCount >= Math.ceil(keywords.length * 0.5)) {
      return inst;
    }
  }

  return null;
}

module.exports = { createInstinct, updateConfidence, getActiveInstincts, matchInstinct };
