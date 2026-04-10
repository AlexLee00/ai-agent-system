#!/usr/bin/env node

/**
 * pickko-pay-pending.js — 결제대기 예약 결제완료 처리
 *
 * 픽코 어드민에서 결제대기 상태인 스터디룸 예약을 찾아 0원 현금으로 결제완료 처리.
 * 앤디(naver-monitor.js)가 픽코 등록은 했지만 결제 단계에서 실패한 경우 사용.
 *
 * 사용법:
 *   node src/pickko-pay-pending.js \
 *     --phone=01071848299 --date=2026-03-07 --start=16:00 --end=18:00 --room=A2
 *
 * 출력 (stdout JSON):
 *   { success: true,  message: "결제완료 처리 완료: ..." }
 *   { success: false, message: "오류 내용" }
 *
 * 플로우:
 *   1. /study/index.html → 전화번호 + 날짜 검색
 *   2. 결과 목록에서 시간 매칭 행 → /study/view/{sd_no}.html
 *   3. 이미 결제완료면 스킵
 *   4. /study/write/{sd_no}.html → "결제하기" 버튼 클릭
 *   5. 결제 모달: 0원 + 현금 + 네이버예약 결제 메모 + #pay_order 제출
 */

const puppeteer = require('puppeteer');
const { delay, log } = require('../../lib/utils');
const { loadSecrets } = require('../../lib/secrets');
const { parseArgs } = require('../../lib/args');
const { formatPhone, toKoreanTime, pickkoEndTime } = require('../../lib/formatting');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../../lib/browser');
const { loginToPickko } = require('../../lib/pickko');
const { IS_DEV, IS_OPS } = require('../../../../packages/core/lib/env');

// ======================== 설정 ========================
const SECRETS   = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;
const MODE      = IS_OPS ? 'ops' : 'dev';

const ARGS          = parseArgs(process.argv);
const PHONE_RAW     = (ARGS.phone || '').replace(/\D/g, '');
const PHONE_FMT     = formatPhone(PHONE_RAW);
const DATE          = ARGS.date  || '';   // YYYY-MM-DD
const START         = ARGS.start || '';   // HH:MM (네이버 기준)
const END           = ARGS.end   || '';   // HH:MM (네이버 기준)
const ROOM          = (ARGS.room || '').toUpperCase();

if (!PHONE_RAW || !DATE || !START || !END || !ROOM) {
  process.stdout.write(JSON.stringify({
    success: false,
    message: '필수 인자 누락: --phone, --date, --start, --end, --room'
  }) + '\n');
  process.exit(1);
}

log(`📋 결제완료 처리 대상: ${PHONE_RAW} / ${DATE} / ${START}~${END} / ${ROOM}룸`);

// ======================== DEV 화이트리스트 ========================
const DEV_WHITELIST = (process.env.DEV_WHITELIST_PHONES || '01035000586,01054350586')
  .split(',').map(p => p.trim()).filter(p => /^\d{10,11}$/.test(p));

if (IS_DEV && !DEV_WHITELIST.includes(PHONE_RAW)) {
  log(`🛑 DEV 모드: 화이트리스트 아님 (${PHONE_RAW}) → 실행 안 함`);
  process.exit(0);
}

// ======================== 결제 유틸 함수 ========================
const norm = (s) => (s ?? '').replace(/[\s,]/g, '').trim();

async function setTopPriceZero(page) {
  const inp = await page.$('#od_add_item_price');
  if (!inp) return false;
  await inp.click({ clickCount: 3 });
  await delay(120);
  try { await page.keyboard.press('Meta+A'); } catch (e) {}
  try { await page.keyboard.press('Control+A'); } catch (e) {}
  for (let k = 0; k < 8; k++) { await page.keyboard.press('Backspace'); await delay(40); }
  await delay(80);
  await page.keyboard.type('0', { delay: 80 });
  await delay(150);
  await page.mouse.click(20, 20);
  return true;
}

async function setMemo(page) {
  try {
    await page.$eval('#od_memo', (el) => {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.value = '네이버예약 결제';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    return true;
  } catch (e) {
    log(`⚠️ 메모 입력 실패: ${e.message}`);
    return false;
  }
}

async function clickCashMouse(page) {
  try {
    await page.waitForSelector('label[for="pay_type1_2"]', { timeout: 5000 });
    const lbl = await page.$('label[for="pay_type1_2"]');
    if (!lbl) throw new Error('현금 label 없음');
    await page.evaluate(() => {
      document.querySelector('label[for="pay_type1_2"]')?.scrollIntoView({ block: 'center' });
    });
    await delay(200);
    const box = await lbl.boundingBox();
    if (!box) throw new Error('현금 label boundingBox 없음');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await delay(150);
    const checked = await page.evaluate(() => document.querySelector('#pay_type1_2')?.checked ?? false);
    log(`💳 현금 선택: checked=${checked}`);
    return checked;
  } catch (e) {
    log(`⚠️ 현금 선택 실패: ${e.message}`);
    return false;
  }
}

async function readTotals(page) {
  return page.evaluate(() => ({
    od_add_item_price: document.querySelector('#od_add_item_price')?.value ?? null,
    od_total_price3:   (document.querySelector('#od_total_price3')?.textContent || '').trim(),
  }));
}

async function waitTotalZeroStable(page) {
  for (let i = 0; i < 10; i++) {
    await delay(250);
    const s1 = await readTotals(page);
    await delay(250);
    const s2 = await readTotals(page);
    log(`🔁 총액 체크#${i + 1}: ${JSON.stringify(s2)}`);
    if (norm(s1.od_total_price3) === '0' && norm(s2.od_total_price3) === '0') return { ok: true, snap: s2 };
  }
  return { ok: false, snap: await readTotals(page) };
}

async function preClickReassertZero(page) {
  try { await page.$eval('#od_add_item_price', el => { el.setAttribute('price', '0'); el.setAttribute('ea', '0'); }); } catch (e) {}
  try { await page.$eval('#od_total_price', el => { el.value = '0'; }); } catch (e) {}
  try {
    const inp = await page.$('#od_add_item_price');
    if (inp) {
      await inp.click({ clickCount: 3 });
      await delay(80);
      try { await page.keyboard.press('Meta+A'); } catch (e) {}
      for (let k = 0; k < 8; k++) { await page.keyboard.press('Backspace'); await delay(30); }
      await page.keyboard.type('0', { delay: 50 });
      await delay(80);
      await page.mouse.click(20, 20);
    }
  } catch (e) {}
}

// ======================== 결제 모달 처리 ========================
async function processPaymentModal(page) {
  // 1. "결제하기" 버튼 클릭
  const payBtnClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
    for (const b of btns) {
      const t = (b.innerText || b.value || b.textContent || '').trim();
      if (t === '결제하기') { b.click(); return true; }
    }
    return false;
  });
  log(payBtnClicked ? '✅ 결제하기 클릭' : '⚠️ 결제하기 버튼 미발견');
  if (!payBtnClicked) return { success: false, reason: '결제하기 버튼 없음' };
  await delay(1200);

  // 2. 결제 모달: 0원 + 현금 + 메모
  let cashOk = false, priceOk = false, memoOk = false, totalText = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    log(`🧾 결제 입력 시도 #${attempt}`);
    priceOk = await setTopPriceZero(page); await delay(250);
    memoOk  = await setMemo(page);         await delay(250);
    cashOk  = await clickCashMouse(page);  await delay(250);
    const stable = await waitTotalZeroStable(page);
    totalText = stable.snap?.od_total_price3 ?? '';
    if (stable.ok) break;
    log(`⚠️ 총액 0 안정화 실패(${totalText}). 재시도...`);
  }
  log(`🧾 입력 결과: priceOk=${priceOk}, memoOk=${memoOk}, cashOk=${cashOk}, totalText=${totalText}`);
  if (norm(totalText) !== '0') {
    return { success: false, reason: `결제 중단: 총액 0 아님 (${totalText})` };
  }

  // 3. #pay_order 제출
  let paySubmitClicked = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    log(`🧾 결제 제출 시도 #${attempt}`);
    await preClickReassertZero(page);
    try {
      await page.waitForSelector('#pay_order', { timeout: 5000 });
      const h = await page.$('#pay_order');
      if (!h) throw new Error('#pay_order 없음');
      await page.evaluate(() => document.querySelector('#pay_order')?.scrollIntoView({ block: 'center' }));
      await delay(150);
      const box = await h.boundingBox();
      if (!box) throw new Error('#pay_order boundingBox 없음');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      paySubmitClicked = true;
    } catch (e) {
      log(`⚠️ 결제 제출 실패: ${e.message}`);
    }
    await delay(600);
    const closed = await page.evaluate(() => !document.querySelector('#order_write'));
    const after  = await page.evaluate(() => (document.querySelector('#od_total_price3')?.textContent || '').trim());
    log(`🔍 제출 후: modalClosed=${closed}, 총액=${after}`);
    if (closed || norm(after) === '0') break;
    log('⚠️ 총액 원복 감지. 재시도...');
    await delay(400);
  }

  // 4. 결제완료 팝업 확인 클릭
  await delay(800);
  const popupResult = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'));
    const btn = btns.find(b => { const t = (b.textContent || b.value || '').trim(); return t === '확인' || t === 'OK'; });
    if (btn) { btn.click(); return { clicked: true, text: (btn.textContent || btn.value || '').trim() }; }
    return { clicked: false };
  });
  log(`팝업 확인: ${JSON.stringify(popupResult)}`);
  await delay(500);

  // 5. 최종 상태 확인
  const finalStatus = await page.evaluate(() => ({
    hasError:   (document.body?.innerText || '').includes('에러') || (document.body?.innerText || '').includes('오류'),
    hasSuccess: (document.body?.innerText || '').includes('완료'),
    url:        window.location.href,
  }));
  log(`🔍 최종: ${JSON.stringify(finalStatus)}`);

  const isSuccess = paySubmitClicked && !finalStatus.hasError;
  return { success: isSuccess, reason: isSuccess ? null : '결제 상태 불명확 (수동 확인 필요)' };
}

// ======================== 메인 ========================
async function run() {
  let browser;
  try {
    browser = await puppeteer.launch(getPickkoLaunchOptions());
    const pages = await browser.pages();
    const page  = pages[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, log);

    // [1단계] 로그인
    log('\n[1단계] 픽코 로그인');
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log(`✅ 로그인 완료`);

    // [2단계] 스터디룸 목록
    log('\n[2단계] /study/index.html 이동');
    await page.goto('https://pickkoadmin.com/study/index.html', { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);

    // [3단계] 검색
    log('\n[3단계] 전화번호 + 날짜 검색');
    await page.evaluate((phone) => {
      const el = document.querySelector('input[name="mb_phone"]');
      if (!el) return;
      el.value = phone;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, PHONE_FMT).catch(() => {});
    log(`📞 전화번호: ${PHONE_FMT}`);

    for (const sel of ['input[name="sd_start_up"]', 'input[name="sd_start_dw"]']) {
      await page.evaluate((s, v) => {
        const el = document.querySelector(s);
        if (!el) return;
        el.removeAttribute('readonly');
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        try { if (window.jQuery?.fn?.datepicker) window.jQuery(el).datepicker('setDate', new Date(v)); } catch (e) {}
      }, sel, DATE).catch(() => {});
    }
    log(`📅 날짜: ${DATE}`);

    await delay(300);
    await page.evaluate(() => {
      const btn = document.querySelector('input[type="submit"].btn_box');
      if (btn) btn.click();
    }).catch(() => {});
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null);
    await delay(1500);

    // [4단계] 목록에서 예약 찾기
    log('\n[4단계] 목록 탐색');
    const startKo = toKoreanTime(START);
    const endKo   = toKoreanTime(pickkoEndTime(END));
    log(`🔍 시간 키: "${startKo}" ~ "${endKo}"`);

    const viewHref = await page.evaluate((startKo, endKo, phone) => {
      const clean = s => (s ?? '').replace(/\s+/g, ' ').trim();
      const trs = Array.from(document.querySelectorAll('tbody tr'));
      // 1순위: 시작+종료 모두 매칭
      for (const tr of trs) {
        const t = clean(tr.textContent);
        if (t.includes(startKo) && t.includes(endKo)) {
          const a = tr.querySelector('a[href*="/study/view/"]');
          if (a) return a.href;
        }
      }
      // 2순위: 시작시간만
      for (const tr of trs) {
        if (clean(tr.textContent).includes(startKo)) {
          const a = tr.querySelector('a[href*="/study/view/"]');
          if (a) return a.href;
        }
      }
      // 3순위: 전화번호 뒷 8자리
      const suf = phone.slice(-8);
      for (const tr of trs) {
        if (clean(tr.textContent).includes(suf)) {
          const a = tr.querySelector('a[href*="/study/view/"]');
          if (a) return a.href;
        }
      }
      return null;
    }, startKo, endKo, PHONE_RAW);

    if (!viewHref) {
      const dump = await page.evaluate(() =>
        Array.from(document.querySelectorAll('tbody tr'))
          .map(tr => (tr.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 150)).join('\n')
      );
      log(`⚠️ 예약 미발견. 목록:\n${dump}`);
      throw new Error(`결제대기 예약 미발견: ${PHONE_RAW} ${DATE} ${START}~${END} ${ROOM}`);
    }
    log(`🔗 view 링크: ${viewHref}`);

    // [5단계] view 페이지 → 이미 결제완료 여부 확인
    log('\n[5단계] view 페이지 이동');
    await page.goto(viewHref, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(1500);

    const viewInfo = await page.evaluate(() => {
      const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
      return {
        isPending:   body.includes('결제대기'),
        isCompleted: body.includes('결제완료'),
        url:         window.location.href,
      };
    });
    log(`📊 view 상태: ${JSON.stringify(viewInfo)}`);

    if (viewInfo.isCompleted && !viewInfo.isPending) {
      log('ℹ️ 이미 결제완료 상태 → 처리 불필요');
      process.stdout.write(JSON.stringify({ success: true, message: '이미 결제완료 상태' }) + '\n');
      try { await browser.close(); } catch (e) {}
      process.exit(0);
    }

    // [6단계] view 페이지에서 결제하기 버튼 클릭 (페이지 재이동 불필요 — 이미 view에 있음)
    log('\n[6단계] view 페이지에서 결제하기 버튼 확인');
    // view 페이지는 [5단계]에서 이미 로드됨
    const hasPayBtn = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]'));
      return btns.some(b => (b.innerText || b.value || b.textContent || '').trim() === '결제하기');
    });

    if (!hasPayBtn) {
      log('⚠️ view 페이지에 결제하기 버튼 없음 → 수동 확인 필요');
      process.stdout.write(JSON.stringify({
        success: false,
        message: `결제하기 버튼 미발견 — 픽코 관리자에서 수동 처리 필요: ${DATE} ${START}~${END} ${ROOM} (${PHONE_RAW})`
      }) + '\n');
      try { await browser.close(); } catch (e) {}
      process.exit(1);
    }

    // [7단계] 결제 모달 처리
    log('\n[7단계] 결제 모달 처리 (0원 현금)');
    const payResult = await processPaymentModal(page);
    log(`💳 결제 결과: ${JSON.stringify(payResult)}`);

    const info = `${DATE} ${START}~${END} ${ROOM}룸 (${PHONE_RAW})`;
    if (payResult.success) {
      process.stdout.write(JSON.stringify({ success: true, message: `결제완료 처리: ${info}` }) + '\n');
      try { await browser.close(); } catch (e) {}
      process.exit(0);
    } else {
      process.stdout.write(JSON.stringify({ success: false, message: payResult.reason }) + '\n');
      try { await browser.close(); } catch (e) {}
      process.exit(1);
    }

  } catch (err) {
    log(`❌ 오류: ${err.message}`);
    process.stdout.write(JSON.stringify({ success: false, message: err.message }) + '\n');
    try { if (browser) await browser.close(); } catch (e) {}
    process.exit(1);
  }
}

run();
