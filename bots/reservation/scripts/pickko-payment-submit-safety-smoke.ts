#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('node:assert');
const { createPickkoPaymentService } = require('../lib/pickko-payment-service');

const noDelay = async () => {};
const buildStageError = (code, message) => Object.assign(new Error(message), { stageCode: code });

function createPaymentPage({ payListStuck = false } = {}) {
  let submitCount = 0;
  let modalOpen = false;
  const input = {
    value: '7000',
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    dispatchEvent() { return true; },
    focus() {},
    blur() {},
  };
  const memo = { value: '', dispatchEvent() { return true; } };
  const totalInput = { value: '7000', dispatchEvent() { return true; } };
  const cash = { checked: true };
  const cashLabel = { click() { cash.checked = true; }, scrollIntoView() {} };
  const payButton = { innerText: '결제하기', click() { modalOpen = true; } };
  const payOrder = { click() { submitCount += 1; } };

  const document = {
    querySelector(selector) {
      if (selector === '#od_add_item_price') return input;
      if (selector === '#od_total_price') return totalInput;
      if (selector === '#od_total_price3') return { textContent: submitCount > 0 ? '1000' : '0' };
      if (selector.includes('pay_list') && selector.includes('price')) {
        return { value: payListStuck ? '7000' : '0' };
      }
      if (selector === '#pay_type1_2') return cash;
      if (selector === 'label[for="pay_type1_2"]') return cashLabel;
      if (selector === '#pay_order') return payOrder;
      if (selector === '#order_write') return modalOpen ? {} : null;
      return null;
    },
    querySelectorAll(selector) {
      return selector.includes('button, a,') ? [payButton] : [];
    },
  };

  const page = {
    async evaluate(fn) {
      const originalDocument = globalThis.document;
      globalThis.document = document;
      try {
        return await fn();
      } finally {
        globalThis.document = originalDocument;
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

async function main() {
  await verifySingleSubmit();
  await verifyStepDeadline();
  await verifyHiddenPriceMismatchBlocksSubmit();
  process.stdout.write('pickko-payment-submit-safety-smoke: ok\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
