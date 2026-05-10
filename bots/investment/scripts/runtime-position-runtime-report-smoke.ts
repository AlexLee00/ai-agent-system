#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { normalizeReportExchange } from './runtime-position-runtime-report.ts';

const cases = [
  { input: null, expected: null },
  { input: '', expected: null },
  { input: 'all', expected: null },
  { input: 'ALL', expected: null },
  { input: '*', expected: null },
  { input: 'binance', expected: 'binance' },
  { input: ' kis_overseas ', expected: 'kis_overseas' },
];

for (const row of cases) {
  assert.equal(normalizeReportExchange(row.input), row.expected);
}

console.log(JSON.stringify({ ok: true, smoke: 'runtime-position-runtime-report', checked: cases.length }, null, 2));
