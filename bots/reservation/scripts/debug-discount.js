#!/usr/bin/env node
/**
 * debug-discount.js — 할인 추가 팝업 DOM 구조 확인
 * #add_dc 클릭 후 팝업 내 input/button 셀렉터 수집
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
  const p = `/tmp/dbg-dc-${stepN}-${label}.png`;
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

(async () => {
  const browser = await puppeteer.launch(getPickkoLaunchOptions());
  const pages = await browser.pages();
  const page = pages[0];
  page.setDefaultTimeout(30000);
  setupDialogHandler(page, log);

  await loginToPickko(page, SECRETS.pickko_id, SECRETS.pickko_pw, delay);
  log('로그인 완료');

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

  // 3시간 + 버튼 클릭
  const svcNo = await page.evaluate(() => {
    const item = Array.from(document.querySelectorAll('#service_price a.use_Y'))
      .find(a => (a.querySelector('.pay_name')?.textContent || '').replace(/\s+/g,'').includes('3시간'));
    return item?.querySelector('.svc_add_btn')?.getAttribute('svc_no') || null;
  });
  log('svc_no: ' + svcNo);

  // 이용권 금액 확인
  const ticketPrice = await page.evaluate(() => {
    const item = Array.from(document.querySelectorAll('#service_price a.use_Y'))
      .find(a => (a.querySelector('.pay_name')?.textContent || '').replace(/\s+/g,'').includes('3시간'));
    if (!item) return null;
    const priceEl = item.querySelector('.pay_price, .price, [class*=price]');
    return priceEl?.textContent?.replace(/[^0-9]/g, '') || null;
  });
  log('이용권 금액(raw): ' + ticketPrice);

  // + 클릭
  await page.evaluate((no) => {
    const btn = document.querySelector(`.svc_add_btn[svc_no="${no}"]`);
    btn?.click();
  }, svcNo);

  const enabled = await waitForPayOrderEnabled(page, 8000);
  log('#pay_order enabled: ' + enabled);

  // 주문정보 영역 분석 (금액 확인)
  const orderInfo = await page.evaluate(() => {
    const orderArea = document.querySelector('#order_info, .order_info, [id*=order]');
    return {
      html: orderArea?.innerHTML?.slice(0, 500) || '없음',
      text: orderArea?.innerText?.slice(0, 200) || '없음',
    };
  });
  log('주문정보 영역: ' + JSON.stringify(orderInfo));

  // 주문 금액 추출 시도
  const orderAmount = await page.evaluate(() => {
    // 여러 셀렉터 시도
    const candidates = [
      '#total_price', '#order_total', '.total_price', '.total_amount',
      '[id*=total]', '[class*=total_price]', '[class*=total_amount]',
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return { sel, text: el.innerText || el.textContent };
    }
    return null;
  });
  log('주문 금액: ' + JSON.stringify(orderAmount));

  await shot(page, '1-before-discount');

  // #add_dc 클릭
  log('\n── #add_dc 클릭 ──');
  await page.evaluate(() => {
    const btn = document.querySelector('#add_dc');
    btn?.scrollIntoView({ block: 'center' });
    btn?.click();
  });
  await delay(1000);
  await shot(page, '2-discount-popup-open');

  // 팝업 내 DOM 전체 수집
  const popupInfo = await page.evaluate(() => {
    // 모달/팝업 요소 탐색
    const modals = Array.from(document.querySelectorAll(
      '[class*=modal],[class*=popup],[class*=layer],[class*=dialog],[id*=modal],[id*=popup],[id*=layer]'
    )).filter(el => el.offsetParent !== null)
      .map(el => ({
        id: el.id,
        cls: el.className.slice(0, 80),
        text: el.innerText?.slice(0, 100) || '',
      }));

    // 모든 visible input
    const inputs = Array.from(document.querySelectorAll('input, textarea, select'))
      .filter(el => el.offsetParent !== null)
      .map(el => ({
        tag: el.tagName, id: el.id, name: el.name,
        type: el.type, placeholder: el.placeholder,
        cls: el.className.slice(0, 60),
        value: el.value,
      }));

    // 모든 visible button
    const btns = Array.from(document.querySelectorAll('button, a.btn_box, input[type=button], input[type=submit]'))
      .filter(el => el.offsetParent !== null)
      .map(el => ({
        tag: el.tagName, id: el.id,
        cls: el.className.slice(0, 60),
        text: (el.innerText || el.value || el.textContent || '').trim().slice(0, 30),
      }))
      .filter(b => b.text.length > 0);

    return { modals, inputs, btns };
  });

  log('모달 목록: ' + JSON.stringify(popupInfo.modals, null, 2));
  log('visible inputs: ' + JSON.stringify(popupInfo.inputs, null, 2));
  log('visible buttons: ' + JSON.stringify(popupInfo.btns, null, 2));

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
