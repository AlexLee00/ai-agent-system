#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('assert');
const { getReportableDexterResults, shouldEmitDexterEvent } = require('../lib/reporter.ts');

const results = [
  {
    name: '리소스',
    status: 'warn',
    items: [{ label: '로그 크기', status: 'warn', detail: 'large' }],
  },
  {
    name: '오류 패턴 분석',
    status: 'error',
    items: [{ label: '반복 오류', status: 'error', detail: 'historical pattern' }],
  },
  {
    name: '덱스터 자기진단',
    status: 'error',
    items: [{ label: '이전 실행 오류', status: 'error', detail: 'meta' }],
  },
  {
    name: '자동 수정',
    status: 'error',
    items: [{ label: '자동 수정 실패', status: 'error', detail: 'meta' }],
  },
];

const reportable = getReportableDexterResults(results);
assert.deepStrictEqual(reportable.map((item) => item.name), ['리소스']);
assert.strictEqual(reportable.some((item) => item.status === 'error'), false);
assert.strictEqual(shouldEmitDexterEvent('warn'), false);
assert.strictEqual(shouldEmitDexterEvent('error'), true);
assert.strictEqual(shouldEmitDexterEvent('ok'), false);

process.env.CLAUDE_DEXTER_SOFT_EVENT_ENABLED = 'true';
assert.strictEqual(shouldEmitDexterEvent('warn'), true);
delete process.env.CLAUDE_DEXTER_SOFT_EVENT_ENABLED;

console.log('✅ dexter reportable event filter excludes meta checks');
