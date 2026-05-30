#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const { loadTsSourceBridge } = require('../../../packages/core/lib/ts-source-bridge.js');
const {
  buildActiveIssueMap,
  classifyPatternStatus,
  shouldExposeHistoricalPattern,
  shouldExposeNewError,
} = loadTsSourceBridge(require('path').join(__dirname, '..', 'lib', 'checks'), 'patterns');

const active = buildActiveIssueMap([
  {
    name: '코드 무결성',
    items: [
      { label: 'TS 런타임 경로 감사', status: 'warn' },
      { label: '문법: broken.js', status: 'error' },
    ],
  },
]);

assert.strictEqual(active.get('코드 무결성||TS 런타임 경로 감사'), 'warn');
assert.strictEqual(active.get('코드 무결성||문법: broken.js'), 'error');

assert.strictEqual(
  classifyPatternStatus({ cnt: 1550 }, active.get('코드 무결성||TS 런타임 경로 감사')),
  'ok',
  'warn-only active patterns must not become extra WARN/ERROR only because they repeat often',
);
assert.strictEqual(
  classifyPatternStatus({ cnt: 1550 }, active.get('코드 무결성||문법: broken.js')),
  'error',
  'active hard failures still become ERROR when repeated',
);
assert.strictEqual(
  classifyPatternStatus({ cnt: 2 }, 'error'),
  'warn',
  'hard failures below threshold should remain WARN',
);
assert.strictEqual(
  shouldExposeHistoricalPattern(new Map(), '코드 무결성||체크섬'),
  false,
  'historical patterns must not re-alert when there are no active warn/error items',
);
assert.strictEqual(
  shouldExposeNewError(new Map(), '에러 로그||ai.luna.daily-pnl-report'),
  false,
  'new historical errors must stay hidden when the current run has no active issue',
);
assert.strictEqual(
  shouldExposeHistoricalPattern(active, '코드 무결성||문법: broken.js'),
  true,
  'active hard pattern remains visible',
);
assert.strictEqual(
  shouldExposeNewError(active, '코드 무결성||문법: broken.js'),
  true,
  'active new hard issue remains visible',
);
assert.strictEqual(
  shouldExposeNewError(active, '코드 무결성||TS 런타임 경로 감사'),
  false,
  'active new soft WARN must not be double-counted by pattern analysis',
);

console.log('✅ dexter pattern severity follows active issue severity');
