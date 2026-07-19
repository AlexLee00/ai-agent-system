#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('node:assert');
const { createPickkoPaymentService } = require('../lib/pickko-payment-service');

globalThis.FocusEvent ||= Event;

const noDelay = async () => {};
const buildStageError = (code, message) => Object.assign(new Error(message), { stageCode: code });

function createPaymentPage({
  payListStuck = false,
  payListEmpty = false,
  pendingDetail = false,
  missingTopPrice = false,
  extraPayListNonZero = false,
  payloadPriceNonZero = false,
} = {}) {
  let submitCount = 0;
  let modalOpen = false;
  let currentTotal = pendingDetail ? '14000' : '0';
  let payListValue = payListStuck ? '7000' : payListEmpty ? '' : pendingDetail ? '14000' : '0';
  const input = {
    value: pendingDetail ? '14000' : '7000',
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    dispatchEvent(event) {
      if (pendingDetail && event.type === 'keyup' && this.value === '0') this.value = '';
      if (pendingDetail && event.type === 'focusout') {
        this.value = '0';
        payListValue = '';
        currentTotal = '0';
      }
      return true;
    },
    focus() {},
    blur() {},
  };
  const payListInput = {
    get value() { return payListValue; },
    set value(value) {
      if (!payListStuck) payListValue = value;
    },
    dispatchEvent() {
      if (pendingDetail && this.value === '0') currentTotal = '0';
      return true;
    },
    focus() {},
    blur() {},
  };
  const extraPayListInput = { value: extraPayListNonZero ? '5000' : '0' };
  const memo = { value: '', dispatchEvent() { return true; } };
  const totalInput = { value: '7000', dispatchEvent() { return true; } };
  const cash = { checked: true };
  const cashLabel = { click() { cash.checked = true; }, scrollIntoView() {} };
  const payButton = { innerText: '결제하기', click() { modalOpen = true; } };
  const payOrder = { click() { submitCount += 1; } };
  const paymentForm = {
    entries() {
      return [
        ['pay_list[0][price]', payListValue],
        ...(payloadPriceNonZero ? [['od_add_item_price', '5000']] : []),
      ];
    },
  };
  input.closest = () => paymentForm;

  const document = {
    querySelector(selector) {
      if (selector === '#od_add_item_price') return missingTopPrice ? null : input;
      if (selector === '#od_total_price') return totalInput;
      if (selector === '#od_total_price3') return { textContent: submitCount > 0 ? '1000' : currentTotal };
      if (selector.includes('pay_list') && selector.includes('price')) {
        return payListInput;
      }
      if (selector === '#pay_type1_2') return cash;
      if (selector === 'label[for="pay_type1_2"]') return cashLabel;
      if (selector === '#pay_order') return payOrder;
      if (selector === '#order_write') return modalOpen ? {} : null;
      if (selector === '#order_write form') return paymentForm;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.includes('pay_list') && selector.includes('price')) {
        return extraPayListNonZero ? [payListInput, extraPayListInput] : [payListInput];
      }
      return selector.includes('button, a,') ? [payButton] : [];
    },
  };

  const page = {
    async evaluate(fn) {
      const originalDocument = globalThis.document;
      const originalFormData = globalThis.FormData;
      globalThis.document = document;
      globalThis.FormData = class {
        constructor(form) { this.form = form; }
        entries() { return this.form.entries(); }
      };
      try {
        return await fn();
      } finally {
        globalThis.document = originalDocument;
        globalThis.FormData = originalFormData;
      }
    },
    async $eval(selector, fn) {
      const element = selector === '#od_memo' ? memo : selector === '#od_total_price' ? totalInput : input;
      return fn(element);
    },
    async waitForSelector() {},
    async $(selector) {
      if (selector === 'label[for="pay_type1_2"]') return { boundingBox: async () => ({ x: 100, y: 10, width: 10, height: 10 }) };
      if (selector === '#pay_order') return { boundingBox: async () => ({ x: 200, y: 10, width: 10, height: 10 }) };
      if (selector === '#od_add_item_price') return { click: async () => {} };
      return null;
    },
    keyboard: {
      press: async () => {},
      type: async () => {},
    },
    mouse: {
      async click(x) {
        if (x > 180) submitCount += 1;
      },
    },
  };

  return { page, getSubmitCount: () => submitCount };
}

async function verifySingleSubmit() {
  const fixture = createPaymentPage();
  const service = createPickkoPaymentService({ delay: noDelay, log: () => {}, stepTimeoutMs: 50 });

  await service.processPaymentStep(fixture.page, { skipPriceZero: false, buildStageError });
  assert.equal(fixture.getSubmitCount(), 1, 'payment submit must be attempted at most once');
}

async function verifyStepDeadline() {
  const page = { evaluate: () => new Promise(() => {}) };
  const service = createPickkoPaymentService({ delay: noDelay, log: () => {}, stepTimeoutMs: 20 });
  const outcome = await Promise.race([
    service.processPaymentStep(page, { skipPriceZero: false, buildStageError })
      .then(() => 'resolved', () => 'rejected'),
    new Promise((resolve) => setTimeout(() => resolve('test_timeout'), 100)),
  ]);
  assert.equal(outcome, 'rejected', 'a stalled CDP call must fail within the payment step deadline');
}

async function verifyHiddenPriceMismatchBlocksSubmit() {
  const fixture = createPaymentPage({ payListStuck: true });
  const service = createPickkoPaymentService({ delay: noDelay, log: () => {}, stepTimeoutMs: 50 });
  await assert.rejects(
    () => service.processPaymentStep(fixture.page, { skipPriceZero: false, buildStageError }),
    /PAYMENT_TOTAL_VALIDATION_FAILED|총 결제금액이 0이 아님/,
  );
  assert.equal(fixture.getSubmitCount(), 0, 'a hidden non-zero payment item must block submission');
}

async function verifyOptionalEmptyPayListAllowsSubmit() {
  const fixture = createPaymentPage({ payListEmpty: true });
  const service = createPickkoPaymentService({ delay: noDelay, log: () => {}, stepTimeoutMs: 50 });
  await service.processPaymentStep(fixture.page, { skipPriceZero: false, buildStageError });
  assert.equal(fixture.getSubmitCount(), 1, 'an empty optional pay-list field must not block zero-price payment');
}

async function verifyPendingDetailPaymentAllocationIsZeroed() {
  const fixture = createPaymentPage({ pendingDetail: true });
  const service = createPickkoPaymentService({ delay: noDelay, log: () => {}, stepTimeoutMs: 50 });
  await service.processPaymentStep(fixture.page, { skipPriceZero: false, buildStageError });
  assert.equal(fixture.getSubmitCount(), 1, 'pending-detail payment allocation must be zeroed before submit');
}

async function verifyMissingTopPriceBlocksSubmit() {
  const fixture = createPaymentPage({ missingTopPrice: true });
  const service = createPickkoPaymentService({ delay: noDelay, log: () => {}, stepTimeoutMs: 50 });
  await assert.rejects(
    () => service.processPaymentStep(fixture.page, { skipPriceZero: false, buildStageError }),
    /가격 입력 필드|총 결제금액/,
  );
  assert.equal(fixture.getSubmitCount(), 0, 'a missing top-price field must fail closed');
}

async function verifyEveryPaymentAllocationMustBeZero() {
  const fixture = createPaymentPage({ extraPayListNonZero: true });
  const service = createPickkoPaymentService({ delay: noDelay, log: () => {}, stepTimeoutMs: 50 });
  await assert.rejects(
    () => service.processPaymentStep(fixture.page, { skipPriceZero: false, buildStageError }),
    /총 결제금액/,
  );
  assert.equal(fixture.getSubmitCount(), 0, 'any non-zero hidden payment allocation must block submit');
}

async function verifySerializedPayloadMustBeZero() {
  const fixture = createPaymentPage({ payloadPriceNonZero: true });
  const service = createPickkoPaymentService({ delay: noDelay, log: () => {}, stepTimeoutMs: 50 });
  await assert.rejects(
    () => service.processPaymentStep(fixture.page, { skipPriceZero: false, buildStageError }),
    /총 결제금액|직렬화/,
  );
  assert.equal(fixture.getSubmitCount(), 0, 'a non-zero serialized payment field must block submit');
}

async function main() {
  await verifySingleSubmit();
  await verifyStepDeadline();
  await verifyHiddenPriceMismatchBlocksSubmit();
  await verifyOptionalEmptyPayListAllowsSubmit();
  await verifyPendingDetailPaymentAllocationIsZeroed();
  await verifyMissingTopPriceBlocksSubmit();
  await verifyEveryPaymentAllocationMustBeZero();
  await verifySerializedPayloadMustBeZero();
  process.stdout.write('pickko-payment-submit-safety-smoke: ok\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
