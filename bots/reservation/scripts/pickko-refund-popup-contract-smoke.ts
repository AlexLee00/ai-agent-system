// @ts-nocheck
'use strict';

const assert = require('node:assert');
const { waitForPickkoRefundPage } = require('../lib/pickko-refund-popup.ts');

function createPage({ opener = null, hasRefund = false } = {}) {
  const target = { opener: () => opener };
  return {
    target: () => target,
    $: async () => (hasRefund ? {} : null),
    setRefund(value) { hasRefund = value; },
  };
}

async function main() {
  const openerPage = createPage();
  const openerTarget = openerPage.target();
  const stalePage = createPage({ hasRefund: true });
  const currentPopup = createPage({ opener: openerTarget, hasRefund: false });
  const unrelatedPopup = createPage({ opener: stalePage.target(), hasRefund: true });
  let polls = 0;
  const browser = {
    pages: async () => {
      polls += 1;
      if (polls === 1) return [openerPage, stalePage];
      if (polls === 2) return [openerPage, stalePage, unrelatedPopup, currentPopup];
      currentPopup.setRefund(true);
      return [openerPage, stalePage, unrelatedPopup, currentPopup];
    },
  };

  const selected = await waitForPickkoRefundPage({
    browser,
    openerPage,
    existingPages: [openerPage, stalePage],
    timeoutMs: 100,
    pollMs: 1,
    delay: async () => {},
  });
  assert.equal(selected, currentPopup, 'only the popup opened by the current reservation may be selected');
  assert.ok(polls >= 3, 'the helper must wait for a delayed current popup');
  console.log('pickko_refund_popup_contract_smoke_ok');
}

main().catch((error) => {
  console.error(error.stack || error.message || error);
  process.exit(1);
});
