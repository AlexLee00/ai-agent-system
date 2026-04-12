#!/usr/bin/env node

const puppeteer = require('puppeteer');
const { delay, log } = require('../../lib/utils');
const { loadSecrets } = require('../../lib/secrets');
const { parseArgs } = require('../../lib/args');
const { formatPhone, toKoreanTime, pickkoEndTime } = require('../../lib/formatting');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../../lib/browser');
const { loginToPickko } = require('../../lib/pickko');
const { publishReservationAlert } = require('../../lib/alert-client');
const { IS_DEV, IS_OPS } = require('../../../../packages/core/lib/env');

const SECRETS = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;
const MODE = IS_OPS ? 'ops' : 'dev';

const ARGS = parseArgs(process.argv);
const PHONE_RAW = (ARGS.phone || '').replace(/\D/g, '');
const PHONE_FORMATTED = formatPhone(PHONE_RAW);
const DATE = ARGS.date || '';
const START = ARGS.start || '';
const END = ARGS.end || '';
const ROOM = ARGS.room || '';
const NAME = (ARGS.name || '고객').slice(0, 20);

if (!PHONE_RAW || !DATE || !START || !END || !ROOM) {
  log('❌ 필수 인자 누락: --phone, --date, --start, --end, --room 모두 필요');
  process.exit(1);
}

log(`📋 취소 대상: ${PHONE_RAW} / ${DATE} / ${START}~${END} / ${ROOM}룸`);

const DEV_WHITELIST = (process.env.DEV_WHITELIST_PHONES || '01035000586,01054350586')
  .split(',')
  .map((p: string) => p.trim())
  .filter((p: string) => /^\d{10,11}$/.test(p));

if (IS_DEV && !DEV_WHITELIST.includes(PHONE_RAW)) {
  log(`🛑 DEV 모드: 화이트리스트 아님 (${PHONE_RAW}) → 취소 실행 안 함`);
  process.exit(0);
}

async function run() {
  let browser: any;
  try {
    browser = await puppeteer.launch(getPickkoLaunchOptions());

    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, log);

    log('\n[1단계] 픽코 로그인');
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log(`✅ 로그인: ${page.url()}`);

    log('\n[2단계] 스터디룸 목록 이동');
    await page.goto('https://pickkoadmin.com/study/index.html', { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);

    log('\n[3단계] 전화번호 + 날짜 검색');
    await page.evaluate((phone: string) => {
      const el = document.querySelector('input[name="mb_phone"]') as HTMLInputElement | null;
      if (!el) return;
      el.value = phone;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, PHONE_FORMATTED).catch(() => {});
    log(`📞 전화번호 입력: ${PHONE_FORMATTED}`);

    await page.evaluate((dateStr: string) => {
      const el = document.querySelector('input[name="sd_start_up"]') as HTMLInputElement | null;
      if (!el) return;
      el.removeAttribute('readonly');
      el.value = dateStr;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      try {
        if ((window as any).jQuery && (window as any).jQuery.fn.datepicker) {
          (window as any).jQuery(el).datepicker('setDate', new Date(dateStr));
        }
      } catch (_e) {}
    }, DATE);
    log(`📅 시작날짜 입력: ${DATE}`);

    await page.evaluate((dateStr: string) => {
      const el = document.querySelector('input[name="sd_start_dw"]') as HTMLInputElement | null;
      if (!el) return;
      el.removeAttribute('readonly');
      el.value = dateStr;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      try {
        if ((window as any).jQuery && (window as any).jQuery.fn.datepicker) {
          (window as any).jQuery(el).datepicker('setDate', new Date(dateStr));
        }
      } catch (_e) {}
    }, DATE);
    log(`📅 종료날짜 입력: ${DATE}`);

    await delay(300);

    await page.evaluate(() => {
      const btn = document.querySelector('input[type="submit"].btn_box') as HTMLElement | null;
      if (btn) btn.click();
    }).catch(() => {});
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null);
    await delay(1500);
    log(`🔍 검색 완료: ${page.url()}`);

    log(`\n[4단계] 목록에서 예약 탐색 (${START}시작)`);

    const startKorean = toKoreanTime(START);
    const endKorean = toKoreanTime(pickkoEndTime(END));
    log(`🔍 매칭 키: "${startKorean}" ~ "${endKorean}"`);

    const viewHref = await page.evaluate((startKo: string, endKo: string, phone: string) => {
      const clean = (s: any) => (s ?? '').replace(/\s+/g, ' ').trim();
      const allTrs = Array.from(document.querySelectorAll('tbody tr'));
      for (const tr of allTrs) {
        const rowText = clean((tr as HTMLElement).textContent);
        if (rowText.includes(startKo) && rowText.includes(endKo)) {
          const link = (tr as HTMLElement).querySelector('a[href*="/study/view/"]') as HTMLAnchorElement | null;
          if (link) return link.href;
        }
      }
      for (const tr of allTrs) {
        const rowText = clean((tr as HTMLElement).textContent);
        if (rowText.includes(startKo)) {
          const link = (tr as HTMLElement).querySelector('a[href*="/study/view/"]') as HTMLAnchorElement | null;
          if (link) return link.href;
        }
      }
      const phoneSuffix = phone.slice(-8);
      for (const tr of allTrs) {
        const rowText = clean((tr as HTMLElement).textContent);
        if (rowText.includes(phoneSuffix)) {
          const link = (tr as HTMLElement).querySelector('a[href*="/study/view/"]') as HTMLAnchorElement | null;
          if (link) return link.href;
        }
      }
      return null;
    }, startKorean, endKorean, PHONE_RAW);

    if (!viewHref) {
      const resultsText = await page.evaluate(() => {
        const trs = Array.from(document.querySelectorAll('tbody tr'));
        return trs.map((tr) => (((tr as HTMLElement).textContent || '').replace(/\s+/g, ' ').trim().slice(0, 150))).join('\n');
      });
      log(`⚠️ 해당 예약을 목록에서 찾지 못함. 결과 목록:\n${resultsText}`);
      throw new Error(`[4단계] 취소 대상 예약 미발견: ${PHONE_RAW} ${DATE} ${START}~${END} ${ROOM}`);
    }

    log(`🔗 상세보기 이동: ${viewHref}`);

    log('\n[5단계] 상세보기');
    await page.goto(viewHref, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(1500);
    log(`🌐 URL: ${page.url()}`);

    const viewInfo = await page.evaluate(() => {
      const clean = (s: any) => (s ?? '').replace(/\s+/g, ' ').trim();
      const body = clean(document.body?.innerText || '');
      const memberMatch = body.match(/회원 정보\s+([^\n]+)/);
      return { member: memberMatch?.[1]?.slice(0, 50) };
    });
    log(`📋 예약 회원: ${viewInfo.member || '(확인 실패)'}`);

    log('\n[6단계] 결제완료 상태 주문상세 버튼 클릭');

    const orderDetailClicked = await page.evaluate(() => {
      const clean = (s: any) => (s ?? '').replace(/\s+/g, ' ').trim();
      const trs = Array.from(document.querySelectorAll('tbody tr, tr'));
      const targetStatus = ['결제완료', '결제대기'];
      const doneStatus = ['환불완료', '환불성공', '취소완료'];

      for (const tr of trs) {
        const rowText = clean((tr as HTMLElement).textContent);
        const hasTarget = targetStatus.some((s) => rowText.includes(s));
        if (!hasTarget) continue;
        const isDone = doneStatus.some((s) => rowText.includes(s));
        if (isDone) continue;
        const btns = Array.from((tr as HTMLElement).querySelectorAll('a, button, input[type="button"]')) as any[];
        for (const btn of btns) {
          const t = clean(btn.textContent || btn.value || '');
          if (t.includes('주문상세')) {
            btn.click();
            return { clicked: true, btnText: t, rowText: rowText.slice(0, 100) };
          }
        }
      }

      const allDone = trs.some((tr) => {
        const rt = clean((tr as HTMLElement).textContent);
        return targetStatus.some((s) => rt.includes(s)) && doneStatus.some((s) => rt.includes(s));
      });
      if (allDone) return { clicked: false, alreadyCancelled: true };
      return { clicked: false };
    });

    log(`주문상세 클릭: ${JSON.stringify(orderDetailClicked)}`);
    if (!orderDetailClicked.clicked) {
      if (orderDetailClicked.alreadyCancelled) {
        log('ℹ️ 이미 환불/취소 완료된 예약입니다. 중복 처리 방지로 종료.');
        process.exit(0);
      }

      log('\n[6-B단계] 주문상세 없음 → 수정 버튼 폴백 시도 (0원/이용중 예약)');
      const editClicked = await page.evaluate(() => {
        const clean = (s: any) => (s ?? '').replace(/\s+/g, ' ').trim();
        const links = Array.from(document.querySelectorAll('a, button, input[type="button"]')) as any[];
        for (const el of links) {
          const t = clean(el.textContent || el.value || '');
          if (t === '수정' || t.includes('수정')) {
            el.click();
            return { clicked: true, text: t, href: el.href || null };
          }
        }
        return { clicked: false };
      });
      log(`  수정 버튼: ${JSON.stringify(editClicked)}`);
      if (!editClicked.clicked) throw new Error('[6-B단계] 수정 버튼 없음');

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null),
        delay(1000),
      ]);
      log(`  이동: ${page.url()}`);

      const cancelSelected = await page.evaluate(() => {
        const radio = document.querySelector('input#sd_step-1, input[name="sd_step"][value="-1"]') as HTMLInputElement | null;
        if (radio) {
          radio.click();
          return { selected: true, id: radio.id, value: radio.value };
        }
        return { selected: false };
      });
      log(`  취소 라디오: ${JSON.stringify(cancelSelected)}`);
      if (!cancelSelected.selected) throw new Error('[6-B단계] 취소(sd_step=-1) 라디오 없음');
      await delay(300);

      const saveClicked = await page.evaluate(() => {
        const clean = (s: any) => (s ?? '').replace(/\s+/g, ' ').trim();
        const candidates = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button')) as any[];
        for (const el of candidates) {
          const t = clean(el.value || el.textContent || '');
          if (t.includes('작성하기') || t.includes('저장') || t.includes('수정하기')) {
            el.click();
            return { clicked: true, text: t };
          }
        }
        return { clicked: false };
      });
      log(`  저장 버튼: ${JSON.stringify(saveClicked)}`);
      if (!saveClicked.clicked) throw new Error('[6-B단계] 저장 버튼 없음');

      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);
      await delay(500);
      log(`✅ [6-B단계] 수정→취소→저장 완료: ${page.url()}`);

      const finalStatusB = await page.evaluate(() =>
        (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      ).catch(() => '');
      const isCancelledB = finalStatusB.includes('취소') || finalStatusB.includes('환불') || finalStatusB.includes('삭제');
      log(`📊 최종 상태: ${isCancelledB ? '취소 확인됨' : '상태 불명확 (수동 확인 권장)'}`);
      log('✅ [SUCCESS] 픽코 예약 취소 완료 (수정→취소→저장 플로우)');
      process.exit(0);
    }
    await delay(1500);

    log('\n[7단계] 결제항목 상세보기 클릭');

    let payViewFound = false;
    try {
      await page.waitForSelector('a.pay_view', { timeout: 8000 });
      payViewFound = true;
    } catch (_e) {
      log('  ⚠️ a.pay_view 미발견 (결제대기 등) → [7-B단계] 폴백');
    }

    if (!payViewFound) {
      log('\n[7-B단계] study/write → 취소 상태 저장 폴백');
      const sdMatch = viewHref.match(/\/study\/view\/(\d+)/);
      const sdNo = sdMatch ? sdMatch[1] : null;
      if (!sdNo) throw new Error('[7-B단계] sd_no 추출 실패');

      await page.goto(`https://pickkoadmin.com/study/write/${sdNo}.html`, {
        waitUntil: 'domcontentloaded', timeout: 20000,
      });
      await delay(1500);
      log(`  이동: ${page.url()}`);

      const cancelSelected = await page.evaluate(() => {
        const radio = document.querySelector('input#sd_step-1, input[name="sd_step"][value="-1"]') as HTMLInputElement | null;
        if (radio) {
          radio.click();
          return { selected: true, id: radio.id, value: radio.value };
        }
        return { selected: false };
      });
      log(`  취소 라디오: ${JSON.stringify(cancelSelected)}`);
      if (!cancelSelected.selected) throw new Error('[7-B단계] 취소(sd_step=-1) 라디오 없음');
      await delay(300);

      const saveClicked = await page.evaluate(() => {
        const clean = (s: any) => (s ?? '').replace(/\s+/g, ' ').trim();
        const candidates = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button')) as any[];
        for (const el of candidates) {
          const t = clean(el.value || el.textContent || '');
          if (t.includes('작성하기') || t.includes('저장') || t.includes('수정하기')) {
            el.click();
            return { clicked: true, text: t };
          }
        }
        return { clicked: false };
      });
      log(`  저장 버튼: ${JSON.stringify(saveClicked)}`);
      if (!saveClicked.clicked) throw new Error('[7-B단계] 저장 버튼 없음');

      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);
      await delay(500);

      const finalStatusB = await page.evaluate(() =>
        (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      ).catch(() => '');
      const isCancelledB = finalStatusB.includes('취소') || finalStatusB.includes('환불') || finalStatusB.includes('삭제');
      log(`📊 최종 상태: ${isCancelledB ? '취소 확인됨' : '상태 불명확 (수동 확인 권장)'}`);
      log('✅ [SUCCESS] 픽코 예약 취소 완료 (결제대기→수정→취소 플로우)');
      process.exit(0);
    }

    await page.click('a.pay_view');
    log('상세보기 클릭: {"clicked":true,"selector":"a.pay_view"}');
    const refundSel = 'a.pay_refund_app, a.pay_refund';
    await delay(3000);

    log('\n[8단계] 환불 버튼 클릭');
    const allPages8 = await browser.pages();
    log(`  열린 페이지 수: ${allPages8.length}`);

    let refundPage8: any = null;
    for (const p of allPages8) {
      try {
        await p.waitForSelector(refundSel, { timeout: 3000 }).catch(() => null);
        const found = await p.evaluate(() => !!document.querySelector('a.pay_refund_app, a.pay_refund'));
        if (found) {
          refundPage8 = p;
          break;
        }
      } catch (_e) {}
    }

    let refundClicked: any = { clicked: false };
    if (refundPage8) {
      refundClicked = await refundPage8.evaluate(() => {
        const btn = document.querySelector('a.pay_refund_app, a.pay_refund') as HTMLAnchorElement | null;
        if (btn) {
          btn.click();
          return { clicked: true, text: (btn.textContent || '').trim(), cls: btn.className };
        }
        return { clicked: false };
      });
    }

    log(`환불 버튼: ${JSON.stringify(refundClicked)}`);
    if (!refundClicked.clicked) {
      log('\n[8-B단계] 환불 버튼 없음 → 수정→취소 폴백 시도 (키오스크 단말 결제 추정)');
      const sdMatch = viewHref.match(/\/study\/view\/(\d+)/);
      const sdNo = sdMatch ? sdMatch[1] : null;
      if (!sdNo) throw new Error('[8단계] 환불 버튼 없음 + sd_no 추출 실패');

      await page.goto(`https://pickkoadmin.com/study/write/${sdNo}.html`, {
        waitUntil: 'domcontentloaded', timeout: 20000,
      });
      await delay(1500);
      log(`  이동: ${page.url()}`);

      const cancelSelected8b = await page.evaluate(() => {
        const radio = document.querySelector('input#sd_step-1, input[name="sd_step"][value="-1"]') as HTMLInputElement | null;
        if (radio) {
          radio.click();
          return { selected: true, id: radio.id, value: radio.value };
        }
        return { selected: false };
      });
      log(`  취소 라디오: ${JSON.stringify(cancelSelected8b)}`);
      if (!cancelSelected8b.selected) throw new Error('[8-B단계] 취소(sd_step=-1) 라디오 없음');
      await delay(300);

      const saveClicked8b = await page.evaluate(() => {
        const clean = (s: any) => (s ?? '').replace(/\s+/g, ' ').trim();
        const candidates = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button')) as any[];
        for (const el of candidates) {
          const t = clean(el.value || el.textContent || '');
          if (t.includes('작성하기') || t.includes('저장') || t.includes('수정하기')) {
            el.click();
            return { clicked: true, text: t };
          }
        }
        return { clicked: false };
      });
      log(`  저장 버튼: ${JSON.stringify(saveClicked8b)}`);
      if (!saveClicked8b.clicked) throw new Error('[8-B단계] 저장 버튼 없음');

      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => null);
      await delay(500);

      const finalStatus8b = await page.evaluate(() =>
        (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      ).catch(() => '');
      const isCancelled8b = finalStatus8b.includes('취소') || finalStatus8b.includes('환불') || finalStatus8b.includes('삭제');
      log(`📊 최종 상태: ${isCancelled8b ? '취소 확인됨' : '상태 불명확 (수동 확인 권장)'}`);
      log('✅ [SUCCESS] 픽코 예약 취소 완료 (결제상세→환불버튼없음→수정→취소 플로우)');
      process.exit(0);
    }
    await delay(1000);

    log('\n[9단계] 처리완료 후 페이지 안정 대기');
    const waitPage9 = refundPage8 || page;
    await waitPage9.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null);
    await delay(500);

    log('\n[10단계] 취소 완료 확인');
    const finalUrl = page.url();
    log(`🌐 최종 URL: ${finalUrl}`);

    const finalStatusText = await page.evaluate(() => {
      const clean = (s: any) => (s ?? '').replace(/\s+/g, ' ').trim();
      return clean(document.body?.innerText || '').slice(0, 500);
    }).catch(() => '');
    const isCancelled = finalStatusText.includes('취소') || finalStatusText.includes('환불');
    log(`📊 최종 상태: ${isCancelled ? '취소/환불 확인됨' : '상태 불명확 (수동 확인 권장)'}`);

    log('✅ [SUCCESS] 픽코 예약 취소 완료!');
    log(`   📞 번호: ${PHONE_RAW}`);
    log(`   📅 날짜: ${DATE}`);
    log(`   ⏰ 시간: ${START}~${END}`);
    log(`   🏛️ 룸: ${ROOM}`);

    if (refundClicked.cls && refundClicked.cls.includes('pay_refund_app') && MODE === 'ops') {
      const msg = [
        `⚠️ [수동처리 필요] 픽코 앱/키오스크 PG 환불 완료`,
        ``,
        `📞 ${PHONE_RAW} (${NAME})`,
        `📅 ${DATE} ${START}~${END} / ${ROOM}룸`,
        ``,
        `💳 PG 환불(IAMPORT)은 성공했으나`,
        `픽코 예약 목록에 예약이 그대로 남아있습니다.`,
        `픽코 어드민에서 수동으로 예약 취소 처리 해주세요.`,
        `(픽코 어드민 버그 — 유지보수 업체 문의 중)`,
      ].join('\n');
      const sent = await publishReservationAlert({
        from_bot: 'jimmy',
        event_type: 'alert',
        alert_level: 3,
        message: msg,
      }).catch((e: any) => {
        log(`텔레그램 알림 실패: ${e.message}`);
        return false;
      });
      log(sent ? '📨 수동처리 알림 발송 완료' : '⚠️ 수동처리 알림 발송 실패');
    }

    process.exit(0);
  } catch (err: any) {
    log(`❌ 취소 처리 오류: ${err.message}`);

    if (MODE === 'ops') {
      log(`\n🚨 [OPS-ERROR] 픽코 취소 실패`);
      log(`   📞 번호: ${PHONE_RAW} / 📅 날짜: ${DATE} / ⏰ ${START}~${END} / 🏛️ ${ROOM}`);
      log(`   ❌ 오류: ${err.message}`);
      log(`   ⚠️ 조치: 픽코 수동 취소 필요`);
    }

    if (process.env.HOLD_BROWSER_ON_ERROR !== '0' && MODE === 'dev') {
      log('🛑 에러 발생: 브라우저 30초 유지 후 종료');
      await delay(30000);
    }

    process.exit(1);
  } finally {
    try { if (browser) await browser.close(); } catch (_e) {}
  }
}

module.exports = { run };

run().catch((err: any) => {
  console.error('pickko-cancel.js 예상치 못한 오류:', err);
  process.exit(1);
});
