// @ts-nocheck
'use strict';

const assert = require('assert');
const { validateSingleDayTimeRange } = require('../lib/validation.ts');

assert.deepEqual(validateSingleDayTimeRange('09:00', '11:00'), {
  ok: true,
  isCrossMidnight: false,
});
assert.deepEqual(validateSingleDayTimeRange('23:30', '00:30'), {
  ok: false,
  error: '자정 통과 예약은 날짜별 예약 2건으로 분리해야 합니다: 23:30 → 00:30',
  isCrossMidnight: true,
});

console.log('pickko_single_day_window_smoke_ok');
