#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const {
  _buildLeadTriageDigest,
  _classifyLeadTriageIssues,
  _shouldCallLeadLlm,
  _recordLeadTriageDecision,
} = require('../lib/claude-lead-brain.js');

const warnIssues = [
  { checkName: '코드 무결성', label: 'git 상태', status: 'warn', detail: 'dirty tree' },
  { checkName: '리소스', label: '루나 국내주식 로그', status: 'warn', detail: 'large log' },
];

const hardIssues = [
  { checkName: '에러 로그', label: 'hub-severity-decay', status: 'error', detail: 'last exit status 1' },
  { checkName: '코드 무결성', label: 'git 상태', status: 'warn', detail: 'dirty tree' },
];

function testSoftIssuesSkipByDefault() {
  const decision = _shouldCallLeadLlm(warnIssues, {
    nowMs: 1000,
    state: { version: 1, digests: {} },
    env: {},
  });
  assert.strictEqual(decision.call, false);
  assert.strictEqual(decision.reason, 'soft_triage_llm_disabled');
  assert.deepStrictEqual(_classifyLeadTriageIssues(warnIssues), {
    severity: 'warn',
    hard: false,
    hardIssueCount: 0,
    issueCount: 2,
  });
}

function testRepeatedSoftSkipDoesNotCall() {
  const digest = _buildLeadTriageDigest(warnIssues);
  const decision = _shouldCallLeadLlm(warnIssues, {
    nowMs: 2000,
    state: {
      version: 1,
      digests: {
        [digest]: {
          firstSeenAtMs: 1000,
          lastSeenAtMs: 1000,
          lastLlmAtMs: 0,
          seenCount: 1,
          severity: 'warn',
          issueCount: 2,
          lastReason: 'soft_triage_llm_disabled',
        },
      },
    },
    env: {},
  });
  assert.strictEqual(decision.call, false);
  assert.strictEqual(decision.reason, 'soft_triage_llm_disabled');
  assert.strictEqual(decision.previous?.seenCount, 1);
}

function testHardIssuesCallOnceThenCooldown() {
  const state = { version: 1, digests: {} };
  const first = _shouldCallLeadLlm(hardIssues, {
    nowMs: 1000,
    state,
    env: { CLAUDE_LEAD_LLM_HARD_COOLDOWN_MS: '1800000' },
  });
  assert.strictEqual(first.call, true);
  assert.strictEqual(first.reason, 'new_or_expired_digest');
  _recordLeadTriageDecision(first, { nowMs: 1000, state, env: {} });

  const second = _shouldCallLeadLlm(hardIssues, {
    nowMs: 1000 + 5 * 60 * 1000,
    state,
    env: { CLAUDE_LEAD_LLM_HARD_COOLDOWN_MS: '1800000' },
  });
  assert.strictEqual(second.call, false);
  assert.strictEqual(second.reason, 'triage_digest_cooldown');
  assert.ok(second.remainingMs > 0);
}

function testDigestIgnoresVolatileDetail() {
  const a = _buildLeadTriageDigest([
    { checkName: '에러 로그', label: 'hub-severity-decay', status: 'error', detail: 'pid 1' },
  ]);
  const b = _buildLeadTriageDigest([
    { checkName: '에러 로그', label: 'hub-severity-decay', status: 'error', detail: 'pid 2' },
  ]);
  assert.strictEqual(a, b);
}

function testForceBypassesCooldown() {
  const state = { version: 1, digests: {} };
  const first = _shouldCallLeadLlm(hardIssues, { nowMs: 1000, state, env: {} });
  _recordLeadTriageDecision(first, { nowMs: 1000, state, env: {} });

  const forced = _shouldCallLeadLlm(hardIssues, {
    nowMs: 2000,
    state,
    env: { CLAUDE_LEAD_LLM_FORCE: 'true' },
  });
  assert.strictEqual(forced.call, true);
  assert.strictEqual(forced.reason, 'force');
}

function testHealthyErrorLogIsSoft() {
  const issues = [
    {
      checkName: '에러 로그',
      label: 'ai.luna.marketdata-mcp',
      status: 'error',
      detail: '324건 — old error | 현재 상태 정상 (running)',
    },
    {
      checkName: 'Git 무결성',
      label: 'Git 변경사항',
      status: 'error',
      detail: '미커밋 변경 10개',
    },
  ];
  const classification = _classifyLeadTriageIssues(issues);
  assert.strictEqual(classification.hard, false);
  assert.strictEqual(classification.hardIssueCount, 0);
  const decision = _shouldCallLeadLlm(issues, {
    nowMs: 1000,
    state: { version: 1, digests: {} },
    env: {},
  });
  assert.strictEqual(decision.call, false);
  assert.strictEqual(decision.reason, 'soft_triage_llm_disabled');
}

testSoftIssuesSkipByDefault();
testRepeatedSoftSkipDoesNotCall();
testHardIssuesCallOnceThenCooldown();
testDigestIgnoresVolatileDetail();
testForceBypassesCooldown();
testHealthyErrorLogIsSoft();

console.log('✅ claude-lead triage throttle policy smoke passed');
