#!/usr/bin/env node
/**
 * debug-ticket.js — 이용권 추가 전 흐름 스크린샷 디버그
 * 각 단계마다 /tmp/dbg-N.png 저장
 */
const puppeteer = require('puppeteer');
const path = require('path');
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

(async () => {
  const browser = await puppeteer.launch({ ...getPickkoLaunchOptions(), headless: false });
  const pages = await browser.pages();
  const page = pages[0];
  page.setDefaultTimeout(30000);
  setupDialogHandler(page, log);

  await loginToPickko(page, SECRETS.pickko_id, SECRETS.pickko_pw, delay);
  log('로그인 완료');

  await page.goto('https://pickkoadmin.com/member/view/3839126.html', { waitUntil: 'load' });
  await delay(2000);
  await shot(page, 'member-view-loaded');

  // stc_no 자유석 선택
  await page.evaluate(() => {
    const sel = document.querySelector('#stc_no');
    const opt = Array.from(sel.querySelectorAll('option')).find(o => o.textContent.includes('자유석'));
    if (opt) {
      sel.value = opt.value;
      if (typeof jQuery !== 'undefined') jQuery(sel).trigger('change');
      else sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  // 이용권 로드 대기
  for (let i = 0; i < 10; i++) {
    await delay(1000);
    const cnt = await page.evaluate(() => document.querySelectorAll('#service_price a.use_Y').length);
    if (cnt > 0) { log(`이용권 로드: ${cnt}개`); break; }
  }
  await shot(page, 'after-stc-select');

  // 3시간 svc_no 확인
  const svc3h = await page.evaluate(() => {
    const items = document.querySelectorAll('#service_price a.use_Y');
    for (const item of items) {
      const payName = (item.querySelector('.pay_name')?.textContent || '').replace(/\s+/g, '');
      if (payName.includes('3시간')) {
        const addBtn = item.querySelector('.svc_add_btn');
        const box = addBtn?.getBoundingClientRect();
        return {
          svcNo: addBtn?.getAttribute('svc_no'),
          tagName: addBtn?.tagName,
          classes: addBtn?.className,
          visible: addBtn?.offsetParent !== null,
          boxX: box?.x, boxY: box?.y, boxW: box?.width, boxH: box?.height,
        };
      }
    }
    return null;
  });
  log('3시간 svc_add_btn: ' + JSON.stringify(svc3h));

  if (!svc3h) { log('3시간 없음'); await browser.close(); return; }

  // + 버튼 실제 마우스 클릭
  log('+ 버튼 마우스 클릭 시도');
  if (svc3h.boxX != null && svc3h.boxW != null) {
    await page.mouse.click(svc3h.boxX + svc3h.boxW / 2, svc3h.boxY + svc3h.boxH / 2);
    log('마우스 클릭 완료');
  } else {
    await page.evaluate((no) => {
      const btn = document.querySelector(`.svc_add_btn[svc_no="${no}"]`);
      btn?.scrollIntoView({ block: 'center' });
      btn?.click();
    }, svc3h.svcNo);
    log('JS click 완료');
  }
  await delay(1000);
  await shot(page, 'after-plus-click');

  // 주문 섹션 상태 확인
  const orderState = await page.evaluate(() => {
    const body = document.body.innerText;
    const relevantLines = body.split('\n')
      .filter(l => l.trim() && (
        l.includes('3시간') || l.includes('주문') || l.includes('결제') ||
        l.includes('합계') || l.includes('금액') || l.includes('수량')
      )).slice(0, 20);
    return {
      relevantLines,
      hasPayOrder: !!(document.querySelector('#pay_order')),
      payWrapHTML: document.querySelector('#pay_wrap, .pay_wrap, #order_wrap, .order_wrap')?.innerHTML?.slice(0, 400) || '없음',
    };
  });
  log('주문 상태: ' + JSON.stringify(orderState, null, 2));

  // 현금 선택
  await page.evaluate(() => {
    const label = document.querySelector('label[for="pay_type1_2"]');
    if (label) label.click();
  });
  await delay(300);
  await shot(page, 'after-cash-select');

  // 결제하기 버튼 찾기 & 클릭
  const payBtnInfo = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], span'));
    const found = btns.filter(b => {
      const t = (b.innerText || b.textContent || b.value || '').trim();
      return t === '결제하기' || t === '결제';
    }).map(b => ({
      tag: b.tagName, id: b.id, cls: b.className, text: (b.innerText || b.textContent || b.value || '').trim().slice(0, 30),
      visible: b.offsetParent !== null, boxX: b.getBoundingClientRect().x, boxY: b.getBoundingClientRect().y,
    }));
    return found;
  });
  log('결제하기 버튼들: ' + JSON.stringify(payBtnInfo, null, 2));

  // 첫번째 visible 결제하기 클릭
  const payBtn = payBtnInfo.find(b => b.visible);
  if (!payBtn) { log('결제하기 버튼 없음'); await browser.close(); return; }

  log('결제하기 클릭: ' + JSON.stringify(payBtn));
  await page.evaluate((id, cls, tag) => {
    let btn;
    if (id) btn = document.getElementById(id);
    if (!btn) {
      const btns = Array.from(document.querySelectorAll(`${tag}[class="${cls}"]`));
      btn = btns.find(b => (b.innerText || b.textContent || b.value || '').trim() === '결제하기');
    }
    if (!btn) {
      const all = Array.from(document.querySelectorAll('button, a, input[type="button"], span'));
      btn = all.find(b => (b.innerText || b.textContent || b.value || '').trim() === '결제하기' && b.offsetParent !== null);
    }
    btn?.click();
  }, payBtn.id, payBtn.cls, payBtn.tag.toLowerCase());
  await delay(2000);
  await shot(page, 'after-pay-click');

  // 주문 상세 팝업 확인
  const afterPayState = await page.evaluate(() => {
    return {
      hasPayOrder: !!(document.querySelector('#pay_order')),
      payOrderVisible: document.querySelector('#pay_order')?.offsetParent !== null,
      payOrderHTML: document.querySelector('#pay_order')?.outerHTML?.slice(0, 200) || '없음',
      visibleModals: Array.from(document.querySelectorAll('.modal, .popup, .layer, [id*="popup"], [id*="modal"]'))
        .filter(el => el.offsetParent !== null)
        .map(el => ({ id: el.id, cls: el.className, html: el.innerHTML.slice(0, 200) }))
        .slice(0, 3),
      pageText: document.body.innerText.split('\n')
        .filter(l => l.trim() && (l.includes('결제') || l.includes('주문') || l.includes('3시간') || l.includes('확인') || l.includes('완료')))
        .slice(0, 20),
    };
  });
  log('결제 후 상태: ' + JSON.stringify(afterPayState, null, 2));

  log('\n=== 30초 대기 중 (크롬에서 직접 확인 후 Ctrl+C) ===');
  await delay(30000);

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
