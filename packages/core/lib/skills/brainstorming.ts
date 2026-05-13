// @ts-nocheck
'use strict';

const kst = require('../kst');

function createSession(topic) {
  return {
    topic: topic || '',
    goal: '',
    alternatives: [],
    tradeoffs: [],
    recommendation: '',
    decisionPending: true,
    createdAt: kst.datetimeStr(),
  };
}

function addAlternative(session, id, name, desc, pros, cons) {
  const target = session || {};
  if (!Array.isArray(target.alternatives)) target.alternatives = [];
  target.alternatives.push({
    id: id || target.alternatives.length + 1,
    name: name || '',
    desc: desc || '',
    pros: Array.isArray(pros) ? pros : [pros].filter(Boolean),
    cons: Array.isArray(cons) ? cons : [cons].filter(Boolean),
  });
  return target;
}

function setTradeoffMatrix(session, criteria, scores) {
  // scores: { altId: { criterion: score } }
  const target = session || {};
  target.tradeoffs = { criteria: criteria || [], scores: scores || {} };
  return target;
}

function setRecommendation(session, altId, reason) {
  const target = session || {};
  target.recommendation = { altId, reason: reason || '' };
  return target;
}

function formatReport(session) {
  const s = session || {};
  const alts = (s.alternatives || [])
    .map((a) => [
      `  \u2460 [${a.id}] ${a.name}: ${a.desc}`,
      `     장: ${(a.pros || []).join(', ')}`,
      `     단: ${(a.cons || []).join(', ')}`,
    ].join('\n'))
    .join('\n');
  const rec = s.recommendation
    ? `  대안 [${s.recommendation.altId}] 권고: ${s.recommendation.reason}`
    : '  미결정';
  return [
    `## 브레인스토밍: ${s.topic}`,
    `### 목표\n  ${s.goal}`,
    `### 대안\n${alts}`,
    `### 권고\n${rec}`,
    `### 결정 대기\n  → 마스터 승인 후 /plan 진행`,
  ].join('\n');
}

module.exports = { createSession, addAlternative, setTradeoffMatrix, setRecommendation, formatReport };
