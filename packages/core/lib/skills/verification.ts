// @ts-nocheck
'use strict';

const { execSync } = require('child_process');
const path = require('path');
const kst = require('../kst');

const VERDICT = { PASS: 'PASS', REVISE: 'REVISE', REJECT: 'REJECT' };

function createSession(target, options) {
  const opts = options || {};
  return {
    target: target || '',
    noDb: !!opts.noDb,
    team: opts.team || '',
    stages: { syntax: null, soft: null, hard: null, integration: null },
    verdict: null,
    nextAction: '',
    createdAt: kst.datetimeStr(),
  };
}

function runSyntaxCheck(session, filePath) {
  const target = session || {};
  try {
    const file = filePath || target.target;
    if (!file) { target.stages.syntax = { pass: true, note: 'no file specified, skip' }; return target; }
    if (file.endsWith('.ts') || file.endsWith('.js')) {
      execSync(`node --check "${file}"`, { stdio: 'pipe' });
    }
    target.stages.syntax = { pass: true, file };
  } catch (err) {
    target.stages.syntax = { pass: false, error: String(err.message || err).slice(0, 300) };
  }
  return target;
}

function recordSoftTest(session, importOk, callResults) {
  const target = session || {};
  const allOk = importOk && (callResults || []).every((r) => r.pass);
  target.stages.soft = { pass: allOk, importOk, callResults: callResults || [] };
  return target;
}

function recordHardTest(session, connected, details) {
  const target = session || {};
  if (target.noDb) {
    target.stages.hard = { pass: true, skipped: true, note: 'noDb mode' };
    return target;
  }
  target.stages.hard = { pass: !!connected, details: details || '' };
  return target;
}

function recordIntegrationCheck(session, protectedOk, breakingChanges) {
  const target = session || {};
  const pass = protectedOk && (!breakingChanges || breakingChanges.length === 0);
  target.stages.integration = {
    pass,
    protectedOk: !!protectedOk,
    breakingChanges: breakingChanges || [],
  };
  return target;
}

function computeVerdict(session) {
  const target = session || {};
  const stages = target.stages || {};
  const results = [stages.syntax, stages.soft, stages.hard, stages.integration].filter(Boolean);
  const failCount = results.filter((s) => !s.pass && !s.skipped).length;
  if (failCount === 0) {
    target.verdict = VERDICT.PASS;
    target.nextAction = 'PR 생성 또는 마스터 확인 진행';
  } else if (failCount <= 2) {
    target.verdict = VERDICT.REVISE;
    target.nextAction = '/systematic-debugging 호출 → 수정 후 재검증';
  } else {
    target.verdict = VERDICT.REJECT;
    target.nextAction = 'git reset --hard 롤백 → /brainstorming 새 설계';
  }
  return target;
}

function formatReport(session) {
  const s = session || {};
  const st = s.stages || {};
  const fmt = (stage, label) => {
    if (!stage) return `### ${label} [SKIP]`;
    const status = stage.skipped ? 'SKIP' : stage.pass ? 'PASS' : 'FAIL';
    const detail = stage.error || stage.note || stage.details || '';
    return `### ${label} [${status}]\n  ${detail || 'OK'}`;
  };
  return [
    `## 검증: ${s.target}`,
    fmt(st.syntax, '1. 문법'),
    fmt(st.soft, '2. 소프트'),
    fmt(st.hard, '3. 하드'),
    fmt(st.integration, '4. 통합'),
    `### 최종 판정: ${s.verdict || '미완료'}\n  → ${s.nextAction || ''}`,
  ].join('\n');
}

module.exports = {
  VERDICT,
  createSession,
  runSyntaxCheck,
  recordSoftTest,
  recordHardTest,
  recordIntegrationCheck,
  computeVerdict,
  formatReport,
};
