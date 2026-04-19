#!/usr/bin/env node

const puppeteer = require('puppeteer');
const { delay, log } = require('../../lib/utils');
const { loadSecrets } = require('../../lib/secrets');
const { parseArgs } = require('../../lib/args');
const { formatPhone, toKoreanTime, pickkoEndTime } = require('../../lib/formatting');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../../lib/browser');
const { loginToPickko } = require('../../lib/pickko');
const { buildReservationCliInsight } = require('../../lib/cli-insight');
const { IS_DEV, IS_OPS } = require('../../../../packages/core/lib/env');

const SECRETS = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;
const MODE = IS_OPS ? 'ops' : 'dev';

const ARGS = parseArgs(process.argv);
const PHONE_RAW = (ARGS.phone || '').replace(/\D/g, '');
const PHONE_FMT = formatPhone(PHONE_RAW);
const DATE = ARGS.date || '';
const START = ARGS.start || '';
const END = ARGS.end || '';
const ROOM = (ARGS.room || '').toUpperCase();

function exitJson(payload: any, code = 0): never {
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(code);
}

async function exitJsonWithInsight({
  payload,
  code = 0,
  title,
  requestType,
  data,
  fallback,
}: {
  payload: Record<string, any>;
  code?: number;
  title: string;
  requestType: string;
  data: Record<string, any>;
  fallback: string;
}): Promise<never> {
  const aiSummary = await buildReservationCliInsight({
    bot: 'pickko-pay-pending',
    requestType,
    title,
    data,
    fallback,
  });
  exitJson({ ...payload, aiSummary }, code);
}

if (!PHONE_RAW || !DATE || !START || !END || !ROOM) {
  exitJson({
    success: false,
    message: '필수 인자 누락: --phone, --date, --start, --end, --room',
  }, 1);
}

log(`📋 결제완료 처리 대상: ${PHONE_RAW} / ${DATE} / ${START}~${END} / ${ROOM}룸`);

const DEV_WHITELIST = (process.env.DEV_WHITELIST_PHONES || '01035000586,01054350586')
  .split(',')
  .map((p: string) => p.trim())
  .filter((p: string) => /^\d{10,11}$/.test(p));

if (IS_DEV && !DEV_WHITELIST.includes(PHONE_RAW)) {
  log(`🛑 DEV 모드: 화이트리스트 아님 (${PHONE_RAW}) → 실행 안 함`);
  process.exit(0);
}

const norm = (s: any) => (s ?? '').replace(/[\s,]/g, '').trim();

async function setTopPriceZero(page: any) {
  const inp = await page.$('#od_add_item_price');
  if (!inp) return false;
  await inp.click({ clickCount: 3 });
  await delay(120);
  try { await page.keyboard.press('Meta+A'); } catch (_e) {}
  try { await page.keyboard.press('Control+A'); } catch (_e) {}
  for (let k = 0; k < 8; k++) {
    await page.keyboard.press('Backspace');
    await delay(40);
  }
  await delay(80);
  await page.keyboard.type('0', { delay: 80 });
  await delay(150);
  await page.mouse.click(20, 20);
  return true;
}

async function setMemo(page: any) {
  try {
    await page.$eval('#od_memo', (el: any) => {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.value = '네이버예약 결제';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    return true;
  } catch (e: any) {
    log(`⚠️ 메모 입력 실패: ${e.message}`);
    return false;
  }
}

async function clickCashMouse(page: any) {
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
    const checked = await page.evaluate(() => (document.querySelector('#pay_type1_2') as HTMLInputElement | null)?.checked ?? false);
    log(`💳 현금 선택: checked=${checked}`);
    return checked;
  } catch (e: any) {
    log(`⚠️ 현금 선택 실패: ${e.message}`);
    return false;
  }
}

async function readTotals(page: any) {
  return page.evaluate(() => ({
    od_add_item_price: (document.querySelector('#od_add_item_price') as HTMLInputElement | null)?.value ?? null,
    od_total_price3: (document.querySelector('#od_total_price3')?.textContent || '').trim(),
  }));
}

async function waitTotalZeroStable(page: any) {
  for (let i = 0; i < 10; i++) {
    await delay(250);
    const s1 = await readTotals(page);
    await delay(250);
    const s2 = await readTotals(page);
    log(`🔁 총액 체크#${i + 1}: ${JSON.stringify(s2)}`);
    if (norm(s1.od_total_price3) === '0' && norm(s2.od_total_price3) === '0') {
      return { ok: true, snap: s2 };
    }
  }
  return { ok: false, snap: await readTotals(page) };
}

async function installBrowserEvalShim(page: any) {
  try {
    await page.evaluateOnNewDocument(() => {
      (window as any).__name = (value: any) => value;
    });
    await page.evaluate(() => {
      (window as any).__name = (value: any) => value;
    }).catch(() => null);
  } catch {
    // Ignore shim failures here; downstream browser errors will remain visible.
  }
}

async function preClickReassertZero(page: any) {
  try { await page.$eval('#od_add_item_price', (el: any) => { el.setAttribute('price', '0'); el.setAttribute('ea', '0'); }); } catch (_e) {}
  try { await page.$eval('#od_total_price', (el: any) => { el.value = '0'; }); } catch (_e) {}
  try {
    const inp = await page.$('#od_add_item_price');
    if (inp) {
      await inp.click({ clickCount: 3 });
      await delay(80);
      try { await page.keyboard.press('Meta+A'); } catch (_e) {}
      for (let k = 0; k < 8; k++) {
        await page.keyboard.press('Backspace');
        await delay(30);
      }
      await page.keyboard.type('0', { delay: 50 });
      await delay(80);
      await page.mouse.click(20, 20);
    }
  } catch (_e) {}
}

async function processPaymentModal(page: any) {
  const payBtnClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]')) as any[];
    for (const b of btns) {
      const t = (b.innerText || b.value || b.textContent || '').trim();
      if (t === '결제하기') {
        b.click();
        return true;
      }
    }
    return false;
  });
  log(payBtnClicked ? '✅ 결제하기 클릭' : '⚠️ 결제하기 버튼 미발견');
  if (!payBtnClicked) return { success: false, reason: '결제하기 버튼 없음' };
  await delay(1200);

  let cashOk = false;
  let priceOk = false;
  let memoOk = false;
  let totalText = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    log(`🧾 결제 입력 시도 #${attempt}`);
    priceOk = await setTopPriceZero(page);
    await delay(250);
    memoOk = await setMemo(page);
    await delay(250);
    cashOk = await clickCashMouse(page);
    await delay(250);
    const stable = await waitTotalZeroStable(page);
    totalText = stable.snap?.od_total_price3 ?? '';
    if (stable.ok) break;
    log(`⚠️ 총액 0 안정화 실패(${totalText}). 재시도...`);
  }
  log(`🧾 입력 결과: priceOk=${priceOk}, memoOk=${memoOk}, cashOk=${cashOk}, totalText=${totalText}`);
  if (norm(totalText) !== '0') {
    return { success: false, reason: `결제 중단: 총액 0 아님 (${totalText})` };
  }

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
    } catch (e: any) {
      log(`⚠️ 결제 제출 실패: ${e.message}`);
    }
    await delay(600);
    const closed = await page.evaluate(() => !document.querySelector('#order_write'));
    const after = await page.evaluate(() => (document.querySelector('#od_total_price3')?.textContent || '').trim());
    log(`🔍 제출 후: modalClosed=${closed}, 총액=${after}`);
    if (closed || norm(after) === '0') break;
    log('⚠️ 총액 원복 감지. 재시도...');
    await delay(400);
  }

  await delay(800);
  const popupResult = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]')) as any[];
    const btn = btns.find((b) => {
      const t = (b.textContent || b.value || '').trim();
      return t === '확인' || t === 'OK';
    });
    if (btn) {
      btn.click();
      return { clicked: true, text: (btn.textContent || btn.value || '').trim() };
    }
    return { clicked: false };
  });
  log(`팝업 확인: ${JSON.stringify(popupResult)}`);
  await delay(500);

  const finalStatus = await page.evaluate(() => ({
    hasError: (document.body?.innerText || '').includes('에러') || (document.body?.innerText || '').includes('오류'),
    hasSuccess: (document.body?.innerText || '').includes('완료'),
    url: window.location.href,
  }));
  log(`🔍 최종: ${JSON.stringify(finalStatus)}`);

  const isSuccess = paySubmitClicked && !finalStatus.hasError;
  return { success: isSuccess, reason: isSuccess ? null : '결제 상태 불명확 (수동 확인 필요)' };
}

async function run() {
  let browser: any;
  try {
    browser = await puppeteer.launch(getPickkoLaunchOptions());
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, log);
    await installBrowserEvalShim(page);

    log('\n[1단계] 픽코 로그인');
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log('✅ 로그인 완료');

    log('\n[2단계] /study/index.html 이동');
    await page.goto('https://pickkoadmin.com/study/index.html', { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);

    log('\n[3단계] 전화번호 + 날짜 검색');
    await page.evaluate((phone: string) => {
      const el = document.querySelector('input[name="mb_phone"]') as HTMLInputElement | null;
      if (!el) return;
      el.value = phone;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, PHONE_FMT).catch(() => {});
    log(`📞 전화번호: ${PHONE_FMT}`);

    for (const sel of ['input[name="sd_start_up"]', 'input[name="sd_start_dw"]']) {
      await page.evaluate((s: string, v: string) => {
        const el = document.querySelector(s) as HTMLInputElement | null;
        if (!el) return;
        el.removeAttribute('readonly');
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        try { if ((window as any).jQuery?.fn?.datepicker) (window as any).jQuery(el).datepicker('setDate', new Date(v)); } catch (_e) {}
      }, sel, DATE).catch(() => {});
    }
    log(`📅 날짜: ${DATE}`);

    await delay(300);
    await page.evaluate(() => {
      const btn = document.querySelector('input[type="submit"].btn_box') as HTMLElement | null;
      if (btn) btn.click();
    }).catch(() => {});
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null);
    await delay(1500);

    log('\n[4단계] 목록 탐색');
    const startKo = toKoreanTime(START);
    const endKo = toKoreanTime(pickkoEndTime(END));
    log(`🔍 시간 키: "${startKo}" ~ "${endKo}"`);

    const viewHref = await page.evaluate((startKo: string, endKo: string, phone: string) => {
      const clean = (s: any) => (s ?? '').replace(/\s+/g, ' ').trim();
      const trs = Array.from(document.querySelectorAll('tbody tr'));
      for (const tr of trs) {
        const t = clean((tr as HTMLElement).textContent);
        if (t.includes(startKo) && t.includes(endKo)) {
          const a = (tr as HTMLElement).querySelector('a[href*="/study/view/"]') as HTMLAnchorElement | null;
          if (a) return a.href;
        }
      }
      for (const tr of trs) {
        if (clean((tr as HTMLElement).textContent).includes(startKo)) {
          const a = (tr as HTMLElement).querySelector('a[href*="/study/view/"]') as HTMLAnchorElement | null;
          if (a) return a.href;
        }
      }
      const suf = phone.slice(-8);
      for (const tr of trs) {
        if (clean((tr as HTMLElement).textContent).includes(suf)) {
          const a = (tr as HTMLElement).querySelector('a[href*="/study/view/"]') as HTMLAnchorElement | null;
          if (a) return a.href;
        }
      }
      return null;
    }, startKo, endKo, PHONE_RAW);

    if (!viewHref) {
      const dump = await page.evaluate(() =>
        Array.from(document.querySelectorAll('tbody tr'))
          .map((tr) => ((tr as HTMLElement).textContent || '').replace(/\s+/g, ' ').trim().slice(0, 150)).join('\n'),
      );
      log(`⚠️ 예약 미발견. 목록:\n${dump}`);
      throw new Error(`결제대기 예약 미발견: ${PHONE_RAW} ${DATE} ${START}~${END} ${ROOM}`);
    }
    log(`🔗 view 링크: ${viewHref}`);

    log('\n[5단계] view 페이지 이동');
    await page.goto(viewHref, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(1500);

    const viewInfo = await page.evaluate(() => {
      const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
      return {
        isPending: body.includes('결제대기'),
        isCompleted: body.includes('결제완료'),
        url: window.location.href,
      };
    });
    log(`📊 view 상태: ${JSON.stringify(viewInfo)}`);

    if (viewInfo.isCompleted && !viewInfo.isPending) {
      log('ℹ️ 이미 결제완료 상태 → 처리 불필요');
      await exitJsonWithInsight({
        payload: { success: true, message: '이미 결제완료 상태' },
        code: 0,
        title: '픽코 결제대기 수동 처리 결과',
        requestType: 'pay-pending',
        data: {
          mode: 'already_completed',
          phone: PHONE_RAW,
          date: DATE,
          start: START,
          end: END,
          room: ROOM,
        },
        fallback: '이미 결제완료 상태라 추가 처리 없이 종료해도 됩니다.',
      });
    }

    log('\n[6단계] view 페이지에서 결제하기 버튼 확인');
    const hasPayBtn = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]')) as any[];
      return btns.some((b) => (b.innerText || b.value || b.textContent || '').trim() === '결제하기');
    });

    if (!hasPayBtn) {
      log('⚠️ view 페이지에 결제하기 버튼 없음 → 수동 확인 필요');
      await exitJsonWithInsight({
        payload: {
          success: false,
          message: `결제하기 버튼 미발견 — 픽코 관리자에서 수동 처리 필요: ${DATE} ${START}~${END} ${ROOM} (${PHONE_RAW})`,
        },
        code: 1,
        title: '픽코 결제대기 수동 처리 결과',
        requestType: 'pay-pending',
        data: {
          mode: 'missing_pay_button',
          phone: PHONE_RAW,
          date: DATE,
          start: START,
          end: END,
          room: ROOM,
        },
        fallback: '자동 결제대기 처리가 막혀 있어 픽코 관리자에서 직접 확인하는 편이 안전합니다.',
      });
    }

    log('\n[7단계] 결제 모달 처리 (0원 현금)');
    const payResult = await processPaymentModal(page);
    log(`💳 결제 결과: ${JSON.stringify(payResult)}`);

    const info = `${DATE} ${START}~${END} ${ROOM}룸 (${PHONE_RAW})`;
    if (payResult.success) {
      await exitJsonWithInsight({
        payload: { success: true, message: `결제완료 처리: ${info}` },
        code: 0,
        title: '픽코 결제대기 수동 처리 결과',
        requestType: 'pay-pending',
        data: {
          mode: 'success',
          phone: PHONE_RAW,
          date: DATE,
          start: START,
          end: END,
          room: ROOM,
        },
        fallback: '결제대기 건이 정상 반영되어 같은 슬롯의 후속 확인 부담이 줄었습니다.',
      });
    } else {
      await exitJsonWithInsight({
        payload: { success: false, message: payResult.reason },
        code: 1,
        title: '픽코 결제대기 수동 처리 결과',
        requestType: 'pay-pending',
        data: {
          mode: 'failure',
          phone: PHONE_RAW,
          date: DATE,
          start: START,
          end: END,
          room: ROOM,
          reason: payResult.reason,
        },
        fallback: '결제대기 처리가 중단돼 같은 예약 슬롯을 수동 재확인하는 편이 좋습니다.',
      });
    }
  } catch (err: any) {
    log(`❌ 오류: ${err.message}`);
    await exitJsonWithInsight({
      payload: { success: false, message: err.message },
      code: 1,
      title: '픽코 결제대기 수동 처리 결과',
      requestType: 'pay-pending',
      data: {
        mode: 'error',
        phone: PHONE_RAW,
        date: DATE,
        start: START,
        end: END,
        room: ROOM,
        error: err.message,
      },
      fallback: '처리 중 오류가 발생해 이번 건은 즉시 수동 점검으로 넘기는 편이 안전합니다.',
    });
  } finally {
    try { if (browser) await browser.close(); } catch (_e) {}
  }
}

module.exports = {
  setTopPriceZero,
  setMemo,
  clickCashMouse,
  readTotals,
  waitTotalZeroStable,
  preClickReassertZero,
  processPaymentModal,
  run,
};

run();
