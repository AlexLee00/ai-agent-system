#!/usr/bin/env node

const puppeteer = require('puppeteer');
const { delay, log } = require('../../lib/utils');
const { loadSecrets } = require('../../lib/secrets');
const { parseArgs } = require('../../lib/args');
const { formatPhone, toKoreanTime, pickkoEndTime } = require('../../lib/formatting');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../../lib/browser');
const { loginToPickko } = require('../../lib/pickko');
const { createPickkoPaymentService } = require('../../lib/pickko-payment-service');
const { buildReservationCliInsight } = require('../../lib/cli-insight');
const {
  derivePickkoPaymentStateFromBody,
  classifyPickkoPaymentOutcome,
  isConfirmedPickkoPaymentCompletion,
  isMatchingPickkoReservationUrl,
} = require('../../lib/report-followup-helpers');
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

const PAYMENT_REVALIDATION_DELAY_MS = 800;
const PAYMENT_STEP_TIMEOUT_MS = (() => {
  const configured = Number(process.env.PICKKO_PAYMENT_STEP_TIMEOUT_MS || 60_000);
  return Number.isFinite(configured) && configured > 0 ? configured : 60_000;
})();

function buildPaymentStageError(code: string, message: string) {
  return Object.assign(new Error(message), { stageCode: code });
}

const paymentService = createPickkoPaymentService({
  delay,
  log,
  stepTimeoutMs: PAYMENT_STEP_TIMEOUT_MS,
});

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

const DEV_WHITELIST = (process.env.DEV_WHITELIST_PHONES || '01035000586,01054350586')
  .split(',')
  .map((p: string) => p.trim())
  .filter((p: string) => /^\d{10,11}$/.test(p));

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

async function readPaymentState(page: any) {
  try {
    const bodyText = await page.evaluate(() => document.body?.innerText || '');
    return { ...derivePickkoPaymentStateFromBody(bodyText), bodyText };
  } catch (error: any) {
    log(`⚠️ 결제 상태 DOM 재검증 읽기 실패: ${error.message}`);
    return null;
  }
}

async function revalidatePaymentState(page: any, reason: string, expectedHref: string | null = null) {
  log(`🔁 결제 상태 재검증 시작: ${reason}`);
  if (expectedHref && !isMatchingPickkoReservationUrl(page.url(), expectedHref)) {
    log(`🛑 결제 상태 재검증 차단: 대상 예약 URL 불일치 (${page.url()})`);
    return null;
  }
  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
  } catch (error: any) {
    log(`⚠️ 결제 상태 재검증 reload 실패: ${error.message}`);
  }
  await delay(PAYMENT_REVALIDATION_DELAY_MS);
  if (expectedHref && !isMatchingPickkoReservationUrl(page.url(), expectedHref)) {
    log(`🛑 결제 상태 재검증 차단: reload 후 대상 예약 URL 이탈 (${page.url()})`);
    return null;
  }
  const state = await readPaymentState(page);
  if (state) {
    log(`🔍 재검증 결과: ${JSON.stringify({
      isPending: state.isPending,
      isCompleted: state.isCompleted,
      statusText: state.statusText,
    })}`);
  }
  return state;
}

async function revalidatePaymentStateFresh(reason: string, expectedHref: string) {
  let freshBrowser: any;
  try {
    log(`🆕 새 브라우저 결제 상태 재검증 시작: ${reason}`);
    freshBrowser = await puppeteer.launch(getPickkoLaunchOptions());
    const pages = await freshBrowser.pages();
    const freshPage = pages[0] || await freshBrowser.newPage();
    freshPage.setDefaultTimeout(30_000);
    setupDialogHandler(freshPage, log);
    await installBrowserEvalShim(freshPage);
    await loginToPickko(freshPage, PICKKO_ID, PICKKO_PW, delay);
    await freshPage.goto(expectedHref, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    await delay(PAYMENT_REVALIDATION_DELAY_MS);
    if (!isMatchingPickkoReservationUrl(freshPage.url(), expectedHref)) {
      log(`🛑 새 브라우저 재검증 차단: 대상 예약 URL 불일치 (${freshPage.url()})`);
      return null;
    }
    const state = await readPaymentState(freshPage);
    if (state) {
      log(`🔍 새 브라우저 재검증 결과: ${JSON.stringify({
        isPending: state.isPending,
        isCompleted: state.isCompleted,
        statusText: state.statusText,
      })}`);
    }
    return state;
  } catch (error: any) {
    log(`⚠️ 새 브라우저 결제 상태 재검증 실패: ${error.message}`);
    return null;
  } finally {
    try { if (freshBrowser) await freshBrowser.close(); } catch (_e) {}
  }
}

async function run() {
  let browser: any;
  let page: any;
  let viewHref: string | null = null;
  if (!PHONE_RAW || !DATE || !START || !END || !ROOM) {
    exitJson({
      success: false,
      message: '필수 인자 누락: --phone, --date, --start, --end, --room',
    }, 1);
  }
  log(`📋 결제완료 처리 대상: ${PHONE_RAW} / ${DATE} / ${START}~${END} / ${ROOM}룸`);
  if (IS_DEV && !DEV_WHITELIST.includes(PHONE_RAW)) {
    log(`🛑 DEV 모드: 화이트리스트 아님 (${PHONE_RAW}) → 실행 안 함`);
    process.exit(0);
  }
  try {
    browser = await puppeteer.launch(getPickkoLaunchOptions());
    const pages = await browser.pages();
    page = pages[0] || await browser.newPage();
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

    viewHref = await page.evaluate((startKo: string, endKo: string, phone: string) => {
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

    const viewState = await readPaymentState(page);
    const viewInfo = {
      isPending: viewState?.isPending ?? false,
      isCompleted: viewState?.isCompleted ?? false,
      statusText: viewState?.statusText || '',
      url: page.url(),
    };
    log(`📊 view 상태: ${JSON.stringify(viewInfo)}`);

    if (isConfirmedPickkoPaymentCompletion(viewInfo)) {
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
      const revalidated = await revalidatePaymentState(page, '결제하기 버튼 미검출', viewHref);
      if (isConfirmedPickkoPaymentCompletion(revalidated)) {
        log('✅ 버튼 미검출 후 재검증에서 이미 결제완료 상태 확인');
        await exitJsonWithInsight({
          payload: { success: true, message: '결제하기 버튼 미검출 후 재검증에서 이미 결제완료 상태' },
          code: 0,
          title: '픽코 결제대기 수동 처리 결과',
          requestType: 'pay-pending',
          data: {
            mode: 'revalidated_completed',
            phone: PHONE_RAW,
            date: DATE,
            start: START,
            end: END,
            room: ROOM,
          },
          fallback: '결제 버튼은 없었지만 상세 페이지 재검증에서 이미 결제완료 상태를 확인했습니다.',
        });
      }
      log('⚠️ view 페이지에 결제하기 버튼 없음 → 재검증 후 수동 확인 필요');
      await exitJsonWithInsight({
        payload: {
          success: false,
          message: `결제하기 버튼 미발견 — 재검증 후 픽코 관리자에서 수동 처리 필요: ${DATE} ${START}~${END} ${ROOM} (${PHONE_RAW})`,
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
    const payResult = await paymentService.processPaymentStep(page, {
      skipPriceZero: false,
      buildStageError: buildPaymentStageError,
    });
    log(`💳 결제 결과: ${JSON.stringify(payResult)}`);
    try { await browser.close(); } catch (_e) {}
    browser = null;
    const confirmedState = await revalidatePaymentStateFresh('결제 제출 후', viewHref);
    const paymentOutcome = classifyPickkoPaymentOutcome(
      payResult.paySubmitClicked,
      isConfirmedPickkoPaymentCompletion(confirmedState),
    );

    const info = `${DATE} ${START}~${END} ${ROOM}룸 (${PHONE_RAW})`;
    if (paymentOutcome === 'verified_paid') {
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
      const failureReason = `결제 상태 검증 실패 (${paymentOutcome}, 수동 확인 필요)`;
      await exitJsonWithInsight({
        payload: { success: false, message: failureReason },
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
          reason: failureReason,
        },
        fallback: '결제대기 처리가 중단돼 같은 예약 슬롯을 수동 재확인하는 편이 좋습니다.',
      });
    }
  } catch (err: any) {
    log(`❌ 오류: ${err.message}`);
    try { if (browser) await browser.close(); } catch (_e) {}
    browser = null;
    const revalidated = viewHref
      ? await revalidatePaymentStateFresh(`작업 예외: ${err.message}`, viewHref)
      : null;
    if (isConfirmedPickkoPaymentCompletion(revalidated)) {
      log('✅ 작업 예외 후 재검증에서 이미 결제완료 상태 확인');
      await exitJsonWithInsight({
        payload: { success: true, message: '작업 예외 후 재검증에서 이미 결제완료 상태' },
        code: 0,
        title: '픽코 결제대기 수동 처리 결과',
        requestType: 'pay-pending',
        data: {
          mode: 'exception_revalidated_completed',
          phone: PHONE_RAW,
          date: DATE,
          start: START,
          end: END,
          room: ROOM,
        },
        fallback: '작업 중 timeout이 발생했지만 상세 페이지 재검증에서 결제완료 상태를 확인했습니다.',
      });
    }
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
  readPaymentState,
  revalidatePaymentState,
  revalidatePaymentStateFresh,
  run,
};

if (require.main === module) run();
