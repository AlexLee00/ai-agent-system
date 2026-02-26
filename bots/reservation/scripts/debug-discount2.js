#!/usr/bin/env node
/**
 * debug-discount2.js — 0원 결제 후 화면 상태 확인
 */
const puppeteer = require('puppeteer');
const { delay, log } = require('../lib/utils');
const { loadSecrets } = require('../lib/secrets');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../lib/browser');
const { loginToPickko } = require('../lib/pickko');

const SECRETS = loadSecrets();
let stepN = 0;
async function shot(page, label) {
  stepN++;
  const p = `/tmp/dbg-dc2-${stepN}-${label}.png`;
  await page.screenshot({ path: p, fullPage: false });
  log(`📸 ${p}`);
}

async function waitForPayOrderEnabled(page, maxMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const enabled = await page.evaluate(() => {
      const btn = document.querySelector('#pay_order');
      return btn && !btn.className.includes('disabled');
    });
    if (enabled) return true;
    await delay(300);
  }
  return false;
}

function dumpButtons(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll(
      'button, a.btn_box, input[type=button], input[type=submit], a[class*=btn]'
    ))
      .filter(b => b.offsetParent !== null)
      .map(b => ({
        tag: b.tagName, id: b.id,
        cls: b.className.slice(0, 70),
        text: (b.innerText || b.value || b.textContent || '').trim().slice(0, 40),
      }))
      .filter(b => b.text.length > 0);
  });
}

(async () => {
  const browser = await puppeteer.launch(getPickkoLaunchOptions());
  const pages = await browser.pages();
  const page = pages[0];
  page.setDefaultTimeout(30000);
  setupDialogHandler(page, log);

  await loginToPickko(page, SECRETS.pickko_id, SECRETS.pickko_pw, delay);
  await page.goto('https://pickkoadmin.com/member/view/3839126.html', { waitUntil: 'load' });
  await delay(2000);

  // 자유석 선택
  await page.evaluate(() => {
    const sel = document.querySelector('#stc_no');
    const opt = Array.from(sel.querySelectorAll('option')).find(o => o.textContent.includes('자유석'));
    if (opt) { sel.value = opt.value; jQuery(sel).trigger('change'); }
  });
  for (let i = 0; i < 12; i++) {
    await delay(1000);
    const cnt = await page.evaluate(() => document.querySelectorAll('#service_price a.use_Y').length);
    if (cnt > 0) { log(`이용권 ${cnt}개 로드`); break; }
  }

  // 3시간 + 클릭
  const svcNo = await page.evaluate(() => {
    const item = Array.from(document.querySelectorAll('#service_price a.use_Y'))
      .find(a => (a.querySelector('.pay_name')?.textContent || '').replace(/\s+/g,'').includes('3시간'));
    return item?.querySelector('.svc_add_btn')?.getAttribute('svc_no') || null;
  });
  await page.evaluate((no) => {
    document.querySelector(`.svc_add_btn[svc_no="${no}"]`)?.click();
  }, svcNo);
  await waitForPayOrderEnabled(page, 8000);
  log('#pay_order 활성화');

  // 할인 추가
  const priceStr = await page.evaluate(() => document.querySelector('input.price1')?.value || '');
  const priceNum = priceStr.replace(/[^0-9]/g, '');
  log('할인 금액: ' + priceNum);

  await page.evaluate(() => { document.querySelector('#add_dc')?.click(); });
  await delay(500);
  await page.evaluate((p) => {
    const dsc = document.querySelector('#add_item_dsc');
    const amt = document.querySelector('#add_item_price');
    if (dsc) { dsc.value = '기타할인'; dsc.dispatchEvent(new Event('input', { bubbles: true })); }
    if (amt) { amt.value = p; amt.dispatchEvent(new Event('input', { bubbles: true })); }
  }, priceNum);
  await delay(200);
  await page.evaluate(() => { document.querySelector('#add_item_ok')?.click(); });
  await delay(800);

  const totalText = await page.evaluate(() =>
    (document.querySelector('.total_price')?.innerText || '').replace(/\n/g, ' '));
  log('할인 후 합계: ' + totalText);

  // 현금 선택
  await page.evaluate(() => { document.querySelector('label[for="pay_type1_2"]')?.click(); });
  await delay(300);

  await shot(page, '1-before-pay');

  // #pay_order 클릭
  log('#pay_order 클릭...');
  await page.evaluate(() => { document.querySelector('#pay_order')?.click(); });
  // native alert은 setupDialogHandler가 처리

  // 500ms씩 로깅
  for (let i = 1; i <= 10; i++) {
    await delay(500);
    const btns = await dumpButtons(page);
    const payStart = btns.find(b => b.cls.includes('pay_start'));
    const payOrder = btns.find(b => b.id === 'pay_order');
    log(`[${i*500}ms] pay_order: ${JSON.stringify(payOrder) || 'none'} | pay_start: ${JSON.stringify(payStart) || 'none'}`);
    if (payStart) { log('pay_start 발견!'); break; }
  }

  await shot(page, '2-after-pay');

  const finalBtns = await dumpButtons(page);
  log('최종 visible buttons: ' + JSON.stringify(finalBtns, null, 2));

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
