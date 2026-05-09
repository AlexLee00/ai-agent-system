#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const { loadTsSourceBridge } = require('../../../packages/core/lib/ts-source-bridge.js');
const {
  buildActiveIssueMap,
  classifyPatternStatus,
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

console.log('✅ dexter pattern severity follows active issue severity');
