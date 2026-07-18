#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { submitPickkoSearch } = require('../lib/pickko');

async function main() {
  let clickCount = 0;
  let navigationCount = 0;
  const originalDocument = (globalThis as any).document;
  const page = {
    waitForNavigation() {
      navigationCount += 1;
      return Promise.resolve(null);
    },
    evaluate(fn: () => unknown) {
      return Promise.resolve(fn());
    },
  };

  try {
    (globalThis as any).document = {
      querySelector(selector: string) {
        assert.strictEqual(selector, 'input[type="submit"][value="검색"]');
        return { click: () => { clickCount += 1; } };
      },
    };
    assert.strictEqual(await submitPickkoSearch(page), true);
    assert.strictEqual(clickCount, 1);
    assert.strictEqual(navigationCount, 1);

    (globalThis as any).document = { querySelector: () => null };
    assert.strictEqual(await submitPickkoSearch(page), false);
  } finally {
    (globalThis as any).document = originalDocument;
  }

  process.stdout.write('pickko-search-submit-smoke: ok\n');
}

main().catch((error: Error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
