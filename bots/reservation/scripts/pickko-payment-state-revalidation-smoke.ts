// @ts-nocheck
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  classifyPickkoPaymentState,
  derivePickkoPaymentStateFromBody,
  extractPickkoPaymentStatusText,
  classifyPickkoPaymentOutcome,
  isConfirmedPickkoPaymentCompletion,
  isAlreadyPaidWithoutButton,
  isMatchingPickkoReservationUrl,
} = require('../lib/report-followup-helpers.ts');

assert.equal(classifyPickkoPaymentOutcome(false, false), 'not_submitted');
assert.equal(classifyPickkoPaymentOutcome(true, false), 'outcome_unknown');
assert.equal(classifyPickkoPaymentOutcome(true, true), 'verified_paid');

const pending = classifyPickkoPaymentState('상태 결제대기 결제금액 14,000 원');
assert.equal(pending.isPending, true);
assert.equal(pending.isCompleted, false);

const completed = classifyPickkoPaymentState('상태 결제완료 결제금액 0 원');
assert.equal(completed.isPending, false);
assert.equal(completed.isCompleted, true);

const ambiguous = classifyPickkoPaymentState('상태 결제대기 작업로그 결제완료');
assert.equal(ambiguous.isPending, true, 'pending must not be treated as completed when both markers exist');
assert.equal(ambiguous.isCompleted, true);

assert.equal(
  extractPickkoPaymentStatusText('예약 정보\n결제상태\n결제대기\n결제금액 14,000원'),
  '결제대기',
);
assert.equal(
  extractPickkoPaymentStatusText('예약 정보\n  결제완료  \n처리 로그'),
  '결제완료',
);
assert.equal(
  extractPickkoPaymentStatusText('예약 정보\n결제상태 결제완료\n처리 로그'),
  '결제완료',
);
assert.equal(
  derivePickkoPaymentStateFromBody('예약 정보\n결제 상태: 결제대기\n처리 로그').isPending,
  true,
);
assert.equal(extractPickkoPaymentStatusText('결제완료 처리 안내 문구'), '');
assert.equal(
  derivePickkoPaymentStateFromBody('결제완료 처리 안내 문구').isCompleted,
  false,
  'generic guidance text must not be accepted as a completed payment state',
);
assert.equal(
  derivePickkoPaymentStateFromBody('예약 정보\n결제상태\n결제완료\n처리 로그').isCompleted,
  true,
);
assert.equal(
  isConfirmedPickkoPaymentCompletion({ isCompleted: true, isPending: false }),
  true,
  'only an unambiguous completed state may be accepted',
);
for (const state of [
  null,
  { isCompleted: false, isPending: false },
  { isCompleted: false, isPending: true },
  { isCompleted: true, isPending: true },
]) {
  assert.equal(
    isConfirmedPickkoPaymentCompletion(state),
    false,
    'missing, pending, and ambiguous states must fail closed',
  );
}
for (const bodyText of [
  '예약 정보\n결제완료\n결제대기\n처리 로그',
  '예약 정보\n결제대기\n결제완료\n처리 로그',
]) {
  const state = derivePickkoPaymentStateFromBody(bodyText);
  assert.equal(state.isPending, true, 'ambiguous live state must preserve the pending marker');
  assert.equal(state.isCompleted, true, 'ambiguous live state must preserve the completed marker');
}
assert.equal(
  isAlreadyPaidWithoutButton(
    { pickkoStatus: 'verified' },
    { ok: false, message: '결제하기 버튼 미발견 — 재검증 후 픽코 관리자에서 수동 처리 필요' },
  ),
  false,
  'failed live revalidation must not be promoted from the cached verified state',
);

const reservationUrl = 'https://pickkoadmin.com/study/view/index.html?reservation_id=123';
assert.equal(
  isMatchingPickkoReservationUrl(`${reservationUrl}#payment`, reservationUrl),
  true,
  'same reservation URL must allow revalidation',
);
assert.equal(
  isMatchingPickkoReservationUrl(
    'https://pickkoadmin.com/study/view/index.html?reservation_id=456',
    reservationUrl,
  ),
  false,
  'another reservation must not be accepted as the target',
);
assert.equal(
  isMatchingPickkoReservationUrl('https://pickkoadmin.com/login.html', reservationUrl),
  false,
  'login redirects must fail closed',
);
assert.equal(
  isMatchingPickkoReservationUrl(
    'https://example.com/study/view/index.html?reservation_id=123',
    'https://example.com/study/view/index.html?reservation_id=123',
  ),
  false,
  'non-Pickko origins must fail closed',
);

const payPendingSource = fs.readFileSync(
  path.resolve(__dirname, '../manual/reports/pickko-pay-pending.ts'),
  'utf8',
);
const paymentResultStart = payPendingSource.indexOf('const payResult = await paymentService.processPaymentStep(page, {');
const paymentResultEnd = payPendingSource.indexOf('} catch (err: any)', paymentResultStart);
assert.ok(paymentResultStart >= 0 && paymentResultEnd > paymentResultStart, 'payment result branch must be present');
const paymentResultBranch = payPendingSource.slice(paymentResultStart, paymentResultEnd);
assert.match(
  paymentResultBranch,
  /await revalidatePaymentStateFresh\(['"]결제 제출 후['"], viewHref\)/,
  'successful submission must use a fresh browser to revalidate the live payment state',
);
assert.match(
  paymentResultBranch,
  /isConfirmedPickkoPaymentCompletion\(/,
  'successful submission must use the fail-closed completion predicate',
);
assert.doesNotMatch(
  payPendingSource,
  /function\s+(?:processPaymentModal|preClickReassertZero)\s*\(/,
  'pay-pending must not keep a second payment implementation',
);
assert.match(
  payPendingSource,
  /if \(require\.main === module\) run\(\);/,
  'pay-pending must remain import-safe for contract tests',
);
const exceptionBranchStart = payPendingSource.indexOf('} catch (err: any) {', paymentResultEnd);
const exceptionBranchEnd = payPendingSource.indexOf('} finally {', exceptionBranchStart);
assert.ok(
  exceptionBranchStart >= 0 && exceptionBranchEnd > exceptionBranchStart,
  'payment exception branch must be present',
);
const exceptionBranch = payPendingSource.slice(exceptionBranchStart, exceptionBranchEnd);
assert.match(
  exceptionBranch,
  /await revalidatePaymentStateFresh\(`/,
  'any payment-path exception must revalidate with a fresh browser',
);
assert.doesNotMatch(
  exceptionBranch,
  /await revalidatePaymentState\(page/,
  'a timed-out browser session must never be reused for payment-state revalidation',
);
assert.doesNotMatch(
  payPendingSource,
  /protocolTimeout:\s*PAYMENT_(?:PROTOCOL|STEP)_TIMEOUT_MS/,
  'the payment step deadline must not replace the browser-wide Pickko protocol timeout',
);

const accurateSource = fs.readFileSync(
  path.resolve(__dirname, '../manual/reservation/pickko-accurate.ts'),
  'utf8',
);
assert.doesNotMatch(
  accurateSource,
  /protocolTimeout:\s*PAYMENT_(?:PROTOCOL|STEP)_TIMEOUT_MS/,
  'accurate registration must preserve the normal browser protocol timeout outside payment',
);

console.log('✅ pickko payment-state revalidation smoke ok');
