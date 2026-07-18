// @ts-nocheck
'use strict';

const assert = require('assert');
const { createPickkoFinalizationService } = require('../lib/pickko-finalization-service.ts');

const service = createPickkoFinalizationService({
  log: () => {},
  buildStageError: (_code, message) => new Error(message),
});

function pageWith(status) {
  return {
    evaluate: async () => status,
  };
}

async function main() {
  const genericCompletedText = await service.readFinalStatus(pageWith({
    pageTitle: 'v.1.6.91',
    hasErrorMsg: false,
    hasSuccessMsg: true,
    url: 'https://pickkoadmin.com/study/view/1051082.html',
    timestamp: 'fixture',
  }));
  assert.equal(
    genericCompletedText.isSuccess,
    false,
    'a generic completed word outside an order result URL must fail closed',
  );

  const orderResult = await service.readFinalStatus(pageWith({
    pageTitle: 'v.1.6.91',
    hasErrorMsg: false,
    hasSuccessMsg: true,
    isPaymentPending: false,
    isPaymentCompleted: true,
    paymentStatusText: '결제완료',
    url: 'https://pickkoadmin.com/study/view/1051082.html#/order/view/23763599',
    timestamp: 'fixture',
  }));
  assert.equal(orderResult.isSuccess, true, 'an explicit completed state on an order result URL must be accepted');

  const pendingOrderResult = await service.readFinalStatus(pageWith({
    pageTitle: 'v.1.6.91',
    hasErrorMsg: false,
    hasSuccessMsg: true,
    isPaymentPending: true,
    isPaymentCompleted: false,
    paymentStatusText: '결제대기',
    url: 'https://pickkoadmin.com/study/view/1051082.html#/order/view/23763599',
    timestamp: 'fixture',
  }));
  assert.equal(
    pendingOrderResult.isSuccess,
    false,
    'an order result URL must not override an explicit pending payment state',
  );

  const orderError = await service.readFinalStatus(pageWith({
    pageTitle: 'v.1.6.91',
    hasErrorMsg: true,
    hasSuccessMsg: true,
    isPaymentPending: false,
    isPaymentCompleted: true,
    paymentStatusText: '결제완료',
    url: 'https://pickkoadmin.com/study/view/1051082.html#/order/view/23763599',
    timestamp: 'fixture',
  }));
  assert.equal(orderError.isSuccess, false, 'an explicit error must override the order result URL');

  console.log('✅ pickko finalization payment-status smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
