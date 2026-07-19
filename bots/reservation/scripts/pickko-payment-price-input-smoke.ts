#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { setPickkoPaymentPriceZero } = require('../lib/pickko-payment-service');

(globalThis as any).FocusEvent ||= Event;

async function main() {
  const events: string[] = [];
  const attributes = new Map([['price', '7000']]);
  const input = {
    value: '7000',
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
    dispatchEvent(event: Event) {
      events.push(event.type);
      return true;
    },
  };
  const originalDocument = (globalThis as any).document;
  const page = {
    evaluate(fn: () => unknown) {
      return Promise.resolve(fn());
    },
  };

  try {
    (globalThis as any).document = {
      querySelector(selector: string) {
        return selector === '#od_add_item_price' ? input : null;
      },
      querySelectorAll() {
        return [];
      },
    };

    assert.strictEqual(await setPickkoPaymentPriceZero(page), true);
    assert.strictEqual(input.value, '0');
    assert.strictEqual(attributes.get('price'), '7000');
    assert.deepStrictEqual(events, ['input', 'change', 'keyup', 'blur', 'focusout']);

    (globalThis as any).document = { querySelector: () => null, querySelectorAll: () => [] };
    assert.strictEqual(await setPickkoPaymentPriceZero(page), false);
  } finally {
    (globalThis as any).document = originalDocument;
  }

  process.stdout.write('pickko-payment-price-input-smoke: ok\n');
}

main().catch((error: Error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
