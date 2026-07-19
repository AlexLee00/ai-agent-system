// @ts-nocheck
'use strict';

const assert = require('assert');
const {
  createPickkoFinalizationService,
  matchesPickkoReservationWindow,
} = require('../lib/pickko-finalization-service.ts');

const service = createPickkoFinalizationService({
  log: () => {},
  buildStageError: (_code, message) => new Error(message),
});

function pageWith(status) {
  return {
    evaluate: async () => status,
  };
}

function domPage({ bodyText, orderViewText, url }) {
  return {
    evaluate: async (fn, ...args) => {
      const originalDocument = globalThis.document;
      const originalWindow = globalThis.window;
      globalThis.document = {
        title: 'v.1.6.91',
        querySelector(selector) {
          if (selector === 'body') return { innerText: bodyText };
          if (selector === '#order_view') return orderViewText == null ? null : { innerText: orderViewText };
          return null;
        },
      };
      globalThis.window = { location: { href: url } };
      try {
        return await fn(...args);
      } finally {
        globalThis.document = originalDocument;
        globalThis.window = originalWindow;
      }
    },
  };
}

async function main() {
  assert.equal(matchesPickkoReservationWindow(
    '2026년 09월 27일 09시 00분 ~ 10시 50분 (2.0시간)',
    { date: '2026-09-27', start: '09:00', end: '10:50' },
  ), true);
  assert.equal(matchesPickkoReservationWindow(
    '2026년 09월 27일 09시 30분 ~ 10시 50분 (1.5시간)',
    { date: '2026-09-27', start: '09:00', end: '10:50' },
  ), false, 'a wrong start time must fail exact draft verification');

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

  const staleBaseStatus = await service.readFinalStatus(domPage({
    bodyText: '예약 상태\n결제대기\n주문 결과\n결제완료',
    orderViewText: '주문상태\n결제완료\n카드결제금액\n0원',
    url: 'https://pickkoadmin.com/study/view/1051630.html#/order/view/23773607',
  }));
  assert.equal(
    staleBaseStatus.isSuccess,
    true,
    'an active completed order view must not be contaminated by stale base-page pending text',
  );

  const expectedReservation = {
    date: '2026-09-27',
    room: 'A2',
    start: '09:00',
    end: '10:50',
    requireZeroAmount: true,
  };
  const exactOrder = await service.readFinalStatus(domPage({
    bodyText: 'stale base page',
    orderViewText: '스터디룸A2 09월 27일 09시 00분 ~ 10시 50분\n주문상태\n결제완료\n카드결제금액\n0원',
    url: 'https://pickkoadmin.com/study/view/1051638.html#/order/view/23773697',
  }), expectedReservation);
  assert.equal(exactOrder.isSuccess, true, 'exact completed zero-won order must pass');

  const wrongOrder = await service.readFinalStatus(domPage({
    bodyText: 'stale base page',
    orderViewText: '스터디룸B 09월 27일 09시 00분 ~ 10시 50분\n주문상태\n결제완료\n카드결제금액\n0원',
    url: 'https://pickkoadmin.com/study/view/1051638.html#/order/view/23773697',
  }), expectedReservation);
  assert.equal(wrongOrder.isSuccess, false, 'wrong-room or non-zero order result must fail closed');

  const unrelatedZero = await service.readFinalStatus(domPage({
    bodyText: 'stale base page',
    orderViewText: '스터디룸A2 09월 27일 09시 00분 ~ 10시 50분\n주문상태\n결제완료\n할인금액\n0원\n카드결제금액\n14,000원',
    url: 'https://pickkoadmin.com/study/view/1051638.html#/order/view/23773697',
  }), expectedReservation);
  assert.equal(
    unrelatedZero.isSuccess,
    false,
    'an unrelated zero-won line must not prove that the final payment amount is zero',
  );

  console.log('✅ pickko finalization payment-status smoke ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
