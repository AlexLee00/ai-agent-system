// @ts-nocheck
'use strict';

const kst = require('../kst');

const SEVERITY = { HIGH: 'H', MEDIUM: 'M', LOW: 'L' };

function createDebugSession(input) {
  const src = input || {};
  return {
    title: src.title || '',
    team: src.team || 'unknown',
    error: src.error || '',
    occuredAt: src.occuredAt || kst.datetimeStr(),
    reproCondition: src.reproCondition || '',
    hypotheses: [],
    verificationResults: [],
    fix: null,
    createdAt: kst.datetimeStr(),
  };
}

function addHypothesis(session, desc, severity, verifyMethod) {
  const target = session || {};
  if (!Array.isArray(target.hypotheses)) target.hypotheses = [];
  target.hypotheses.push({
    id: target.hypotheses.length + 1,
    desc: desc || '',
    severity: severity || SEVERITY.MEDIUM,
    verifyMethod: verifyMethod || '',
    result: null,
  });
  return target;
}

function recordVerification(session, hypothesisId, result, nextAction) {
  const target = session || {};
  if (!Array.isArray(target.hypotheses)) return target;
  const h = target.hypotheses.find((item) => item.id === hypothesisId);
  if (h) {
    h.result = result || '';
    h.nextAction = nextAction || '';
  }
  if (!Array.isArray(target.verificationResults)) target.verificationResults = [];
  target.verificationResults.push({ hypothesisId, result, nextAction, at: kst.datetimeStr() });
  return target;
}

function recordFix(session, filePath, lineRange, change, regressionTest) {
  const target = session || {};
  target.fix = {
    filePath: filePath || '',
    lineRange: lineRange || '',
    change: change || '',
    regressionTest: regressionTest || '',
    fixedAt: kst.datetimeStr(),
  };
  return target;
}

function validateSession(session) {
  const target = session || {};
  const issues = [];
  if (!target.title) issues.push('제목 누락');
  if (!target.error) issues.push('에러 메시지 누락');
  if (!Array.isArray(target.hypotheses) || target.hypotheses.length < 1) {
    issues.push('가설 최소 1개 필요');
  }
  return { valid: issues.length === 0, issues };
}

function formatReport(session) {
  const s = session || {};
  const hyps = (s.hypotheses || [])
    .map((h) => `  - H${h.id} [${h.severity}]: ${h.desc} → 검증: ${h.verifyMethod}`)
    .join('\n');
  const results = (s.verificationResults || [])
    .map((r) => `  - H${r.hypothesisId}: ${r.result} → ${r.nextAction}`)
    .join('\n');
  const fix = s.fix
    ? `  - 파일: ${s.fix.filePath}\n  - 변경: ${s.fix.change}\n  - 회귀 방지: ${s.fix.regressionTest}`
    : '  - 미완료';
  return [
    `## 디버깅: ${s.title}`,
    `### 1. 증상`,
    `  - 에러: ${s.error}`,
    `  - 발생 시점: ${s.occuredAt}`,
    `  - 재현 조건: ${s.reproCondition}`,
    `### 2. 가설`,
    hyps,
    `### 3. 검증 결과`,
    results || '  - 미완료',
    `### 4. 수정`,
    fix,
  ].join('\n');
}

module.exports = {
  SEVERITY,
  createDebugSession,
  addHypothesis,
  recordVerification,
  recordFix,
  validateSession,
  formatReport,
};
