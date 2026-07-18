#!/usr/bin/env node
// @ts-nocheck
'use strict';

const assert = require('node:assert');
const puppeteer = require('puppeteer');
const { createPickkoPaymentService } = require('../lib/pickko-payment-service');

const fixtureHtml = `<!doctype html>
<html lang="ko">
<body>
  <button id="open-payment">결제하기</button>
  <script>
    window.submitCount = 0;
    document.querySelector('#open-payment').addEventListener('click', () => {
      const modal = document.createElement('div');
      modal.id = 'order_write';
      modal.innerHTML = [
        '<input id="od_add_item_price" value="7000" price="7000">',
        '<input id="od_total_price" value="7000">',
        '<input name="pay_list[0][price]" value="7000">',
        '<span id="od_total_price3">7000</span>',
        '<textarea id="od_memo"></textarea>',
        '<input id="pay_type1_2" type="radio" name="pay_type">',
        '<label for="pay_type1_2">현금</label>',
        '<button id="pay_order">결제하기</button>',
      ].join('');
      document.body.appendChild(modal);
      const price = modal.querySelector('#od_add_item_price');
      const refreshTotal = () => {
        modal.querySelector('#od_total_price3').textContent = price.value;
        modal.querySelector('input[name="pay_list[0][price]"]').value = price.value;
      };
      price.addEventListener('input', refreshTotal);
      price.addEventListener('change', refreshTotal);
      modal.querySelector('#pay_order').addEventListener('click', () => {
        window.submitCount += 1;
        modal.remove();
        const confirm = document.createElement('button');
        confirm.textContent = '확인';
        confirm.addEventListener('click', () => confirm.remove());
        document.body.appendChild(confirm);
      });
    });
  </script>
</body>
</html>`;

const buildStageError = (code, message) => Object.assign(new Error(message), { stageCode: code });

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    protocolTimeout: 5_000,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    for (let iteration = 1; iteration <= 5; iteration += 1) {
      const page = await browser.newPage();
      await page.setContent(fixtureHtml, { waitUntil: 'domcontentloaded' });
      const service = createPickkoPaymentService({
        delay: async () => {},
        log: () => {},
        stepTimeoutMs: 1_000,
      });
      const result = await service.processPaymentStep(page, {
        skipPriceZero: false,
        buildStageError,
      });
      const state = await page.evaluate(() => ({
        submitCount: window.submitCount,
        modalOpen: !!document.querySelector('#order_write'),
      }));
      assert.equal(result.paySubmitClicked, true, `iteration ${iteration}: submit acknowledgement`);
      assert.equal(state.submitCount, 1, `iteration ${iteration}: exactly one submit`);
      assert.equal(state.modalOpen, false, `iteration ${iteration}: modal closed`);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  process.stdout.write('pickko-payment-browser-hard-smoke: 5/5 ok\n');
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
