// @ts-nocheck
'use strict';

const assert = require('assert');
const { classifyPickkoPaymentState } = require('../lib/report-followup-helpers.ts');

const pending = classifyPickkoPaymentState('상태 결제대기 결제금액 14,000 원');
assert.equal(pending.isPending, true);
assert.equal(pending.isCompleted, false);

const completed = classifyPickkoPaymentState('상태 결제완료 결제금액 0 원');
assert.equal(completed.isPending, false);
assert.equal(completed.isCompleted, true);

const ambiguous = classifyPickkoPaymentState('상태 결제대기 작업로그 결제완료');
assert.equal(ambiguous.isPending, true, 'pending must not be treated as completed when both markers exist');
assert.equal(ambiguous.isCompleted, true);

console.log('✅ pickko payment-state revalidation smoke ok');
