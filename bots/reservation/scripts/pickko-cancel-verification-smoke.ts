// @ts-nocheck
'use strict';

const assert = require('node:assert');
const {
  assessPickkoCancellationEvidence,
} = require('../lib/pickko-cancel-verification.ts');

function main() {
  assert.deepStrictEqual(
    assessPickkoCancellationEvidence({ statusTexts: ['환불완료'] }),
    { confirmed: true, status: '환불완료' },
  );
  assert.deepStrictEqual(
    assessPickkoCancellationEvidence({ statusTexts: ['취소완료'] }),
    { confirmed: true, status: '취소완료' },
  );
  assert.deepStrictEqual(
    assessPickkoCancellationEvidence({ statusTexts: ['결제완료'], controlTexts: ['취소', '환불'] }),
    { confirmed: false, status: null },
    'interactive cancel/refund controls are not completion evidence',
  );
  assert.deepStrictEqual(
    assessPickkoCancellationEvidence({ statusTexts: [] }),
    { confirmed: false, status: null },
  );
  console.log('pickko_cancel_verification_smoke_ok');
}

main();
