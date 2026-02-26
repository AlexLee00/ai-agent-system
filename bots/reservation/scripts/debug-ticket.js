#!/usr/bin/env node
/**
 * debug-ticket.js — 결제하기 활성화 후 완전한 흐름 추적
 * 핵심: + click 후 충분한 대기 → 두 번째 팝업 확인
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
  const p = `/tmp/dbg-${stepN}-${label}.png`;
  await page.screenshot({ path: p, fullPage: false });
  log(`📸 ${p}`);
}

// 버튼이 enabled(disabled 클래스 제거)될 때까지 폴링
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

  // stc_no 자유석 선택
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

  // 3시간 + 버튼 JS click
  const svcNo = await page.evaluate(() => {
    const item = Array.from(document.querySelectorAll('#service_price a.use_Y'))
      .find(a => (a.querySelector('.pay_name')?.textContent || '').replace(/\s+/g,'').includes('3시간'));
    return item?.querySelector('.svc_add_btn')?.getAttribute('svc_no') || null;
  });
  log('svc_no: ' + svcNo);
  await page.evaluate((no) => {
    const btn = document.querySelector(`.svc_add_btn[svc_no="${no}"]`);
    btn?.scrollIntoView({ block: 'center' });
    btn?.click();
  }, svcNo);

  // 결제하기 버튼이 enabled될 때까지 폴링 (최대 8초)
  const enabled = await waitForPayOrderEnabled(page, 8000);
  log('#pay_order enabled: ' + enabled);
  if (!enabled) { log('❌ 버튼 활성화 실패'); await browser.close(); return; }

  // 현금 선택
  await page.evaluate(() => {
    const label = document.querySelector('label[for="pay_type1_2"]');
    if (label) label.click();
  });
  await delay(300);
  await shot(page, '1-ready-to-pay');

  // ── 결제하기 (#pay_order) 클릭 ──
  log('결제하기 (#pay_order) 클릭...');
  await page.evaluate(() => {
    const btn = document.querySelector('#pay_order');
    btn?.click();
  });

  // 팝업 1 처리 후 2초 기다리기 (setupDialogHandler가 자동 처리)
  await delay(2000);
  await shot(page, '2-after-first-pay');

  // 이 시점의 화면 상태 확인
  const stateAfterFirst = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a.btn_box, input[type=button], input[type=submit]'))
      .filter(b => b.offsetParent !== null)
      .map(b => ({
        tag: b.tagName, id: b.id, cls: b.className.slice(0,60),
        text: (b.innerText || b.value || b.textContent || '').trim().slice(0,30),
        x: b.getBoundingClientRect().x, y: b.getBoundingClientRect().y,
      }))
      .filter(b => b.text.length > 0);
    const modals = Array.from(document.querySelectorAll('[class*=modal],[class*=popup],[class*=layer]'))
      .filter(el => el.offsetParent !== null)
      .map(el => ({ id: el.id, cls: el.className.slice(0,50), text: el.innerText?.slice(0,150) || '' }));
    return { btns, modals, url: location.href };
  });
  log('결제 후 버튼들: ' + JSON.stringify(stateAfterFirst.btns.slice(0, 10), null, 2));
  log('모달: ' + JSON.stringify(stateAfterFirst.modals, null, 2));

  // 추가 2초 대기 후 다시 확인
  await delay(2000);
  await shot(page, '3-final-state');

  const finalBtns = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a.btn_box, input[type=button], input[type=submit]'))
      .filter(b => b.offsetParent !== null)
      .map(b => ({ id: b.id, cls: b.className.slice(0,60), text: (b.innerText || b.value || b.textContent || '').trim().slice(0,30) }))
      .filter(b => b.text.length > 0);
    const payOrder = document.querySelector('#pay_order');
    return {
      payOrderClass: payOrder?.className || 'none',
      visibleBtns: btns,
    };
  });
  log('최종 버튼들: ' + JSON.stringify(finalBtns, null, 2));

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
