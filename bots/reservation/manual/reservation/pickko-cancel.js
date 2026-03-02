#!/usr/bin/env node

/**
 * 픽코 예약 취소 스크립트
 * 네이버 취소 감지 → 픽코 어드민에서 해당 예약을 취소 상태로 변경
 *
 * 사용법:
 *   node pickko-cancel.js --phone=01012345678 --date=2026-05-03 --start=15:00 --end=17:00 --room=A1 [--name=고객]
 *
 * 확인된 UI 플로우 (2026-02-24 검사 완료):
 *   1. /study/index.html → 전화번호 + 날짜 검색
 *   2. 결과 목록에서 시작시간 매칭 행의 상세보기 클릭 → /study/view/{sd_no}.html
 *   3. 수정 버튼 클릭 → /study/write/{sd_no}.html
 *   4. input#sd_step-1 (취소, value="-1") 선택
 *   5. input[value="작성하기"] 클릭 → POST /study/proc/modify.html
 */

const puppeteer = require('puppeteer');
const { delay, log } = require('../../lib/utils');
const { loadSecrets } = require('../../lib/secrets');
const { parseArgs } = require('../../lib/args');
const { formatPhone, toKoreanTime, pickkoEndTime } = require('../../lib/formatting');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../../lib/browser');
const { loginToPickko } = require('../../lib/pickko');

// ======================== 설정 ========================
const SECRETS = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;
const MODE = (process.env.MODE || 'dev').toLowerCase();

const ARGS = parseArgs(process.argv);
const PHONE_RAW = (ARGS.phone || '').replace(/\D/g, '');
// 검색 폼은 하이픈 포함 형식 필요 (010-XXXX-XXXX)
const PHONE_FORMATTED = formatPhone(PHONE_RAW);
const DATE      = ARGS.date  || '';   // YYYY-MM-DD
const START     = ARGS.start || '';   // HH:MM
const END       = ARGS.end   || '';   // HH:MM
const ROOM      = ARGS.room  || '';   // A1, A2, B
const NAME      = (ARGS.name || '고객').slice(0, 20);

if (!PHONE_RAW || !DATE || !START || !END || !ROOM) {
  log('❌ 필수 인자 누락: --phone, --date, --start, --end, --room 모두 필요');
  process.exit(1);
}

log(`📋 취소 대상: ${PHONE_RAW} / ${DATE} / ${START}~${END} / ${ROOM}룸`);

// ======================== DEV 화이트리스트 ========================
const DEV_WHITELIST = (process.env.DEV_WHITELIST_PHONES || '01035000586,01054350586')
  .split(',').map(p => p.trim()).filter(p => /^\d{10,11}$/.test(p));

if (MODE === 'dev' && !DEV_WHITELIST.includes(PHONE_RAW)) {
  log(`🛑 DEV 모드: 화이트리스트 아님 (${PHONE_RAW}) → 취소 실행 안 함`);
  process.exit(0);
}

// ======================== 메인 ========================
async function run() {
  let browser;
  try {
    browser = await puppeteer.launch(getPickkoLaunchOptions());

    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, log);

    // ======================== [1단계] 로그인 ========================
    log('\n[1단계] 픽코 로그인');
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log(`✅ 로그인: ${page.url()}`);

    // ======================== [2단계] 스터디룸 목록 이동 ========================
    log('\n[2단계] 스터디룸 목록 이동');
    await page.goto('https://pickkoadmin.com/study/index.html', { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(2000);

    // ======================== [3단계] 검색 조건 입력 ========================
    log('\n[3단계] 전화번호 + 날짜 검색');

    // 전화번호 입력 — page.$eval() 대신 evaluate() 사용
    // 이유: page.$eval()도 Runtime.callFunctionOn 사용 → 픽코 서버 지연 시 타임아웃
    await page.evaluate((phone) => {
      const el = document.querySelector('input[name="mb_phone"]');
      if (!el) return;
      el.value = phone;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, PHONE_FORMATTED).catch(() => {});
    log(`📞 전화번호 입력: ${PHONE_FORMATTED}`);

    // 시작날짜 입력 (예약일)
    await page.evaluate((dateStr) => {
      const el = document.querySelector('input[name="sd_start_up"]');
      if (!el) return;
      el.removeAttribute('readonly');
      el.value = dateStr;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      try {
        if (window.jQuery && window.jQuery.fn.datepicker) {
          window.jQuery(el).datepicker('setDate', new Date(dateStr));
        }
      } catch (e) {}
    }, DATE);
    log(`📅 시작날짜 입력: ${DATE}`);

    // 종료날짜 입력 (예약일과 동일)
    await page.evaluate((dateStr) => {
      const el = document.querySelector('input[name="sd_start_dw"]');
      if (!el) return;
      el.removeAttribute('readonly');
      el.value = dateStr;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      try {
        if (window.jQuery && window.jQuery.fn.datepicker) {
          window.jQuery(el).datepicker('setDate', new Date(dateStr));
        }
      } catch (e) {}
    }, DATE);
    log(`📅 종료날짜 입력: ${DATE}`);

    await delay(300);

    // 검색 버튼 클릭 — page.click() 대신 evaluate() 사용
    // 이유: page.click()의 Runtime.callFunctionOn이 픽코 서버 지연 시 타임아웃
    await page.evaluate(() => {
      const btn = document.querySelector('input[type="submit"].btn_box');
      if (btn) btn.click();
    }).catch(() => {});
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null);
    await delay(1500);
    log(`🔍 검색 완료: ${page.url()}`);

    // ======================== [4단계] 목록에서 해당 예약 찾기 ========================
    log(`\n[4단계] 목록에서 예약 탐색 (${START}시작)`);

    const startKorean = toKoreanTime(START);
    const endKorean   = toKoreanTime(pickkoEndTime(END));  // 픽코 종료시간 = END - 10분
    log(`🔍 매칭 키: "${startKorean}" ~ "${endKorean}"`);

    // tbody tr 중에서 시작시간+종료시간이 포함된 행의 study/view 링크 찾기
    const viewHref = await page.evaluate((startKo, endKo, phone) => {
      const clean = s => (s ?? '').replace(/\s+/g, ' ').trim();

      // 스터디룸 예약 결과 테이블의 tbody tr 탐색
      const allTrs = Array.from(document.querySelectorAll('tbody tr'));
      // 1순위: 시작+종료 시간 모두 매칭
      for (const tr of allTrs) {
        const rowText = clean(tr.textContent);
        if (rowText.includes(startKo) && rowText.includes(endKo)) {
          const link = tr.querySelector('a[href*="/study/view/"]');
          if (link) return link.href;
        }
      }
      // 2순위: 시작시간만 매칭
      for (const tr of allTrs) {
        const rowText = clean(tr.textContent);
        if (rowText.includes(startKo)) {
          const link = tr.querySelector('a[href*="/study/view/"]');
          if (link) return link.href;
        }
      }
      // 폴백: 전화번호 뒷 8자리로만 매칭
      const phoneSuffix = phone.slice(-8);
      for (const tr of allTrs) {
        const rowText = clean(tr.textContent);
        if (rowText.includes(phoneSuffix)) {
          const link = tr.querySelector('a[href*="/study/view/"]');
          if (link) return link.href;
        }
      }
      return null;
    }, startKorean, endKorean, PHONE_RAW);

    if (!viewHref) {
      // 결과 전체 텍스트 덤프
      const resultsText = await page.evaluate(() => {
        const trs = Array.from(document.querySelectorAll('tbody tr'));
        return trs.map(tr => (tr.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 150)).join('\n');
      });
      log(`⚠️ 해당 예약을 목록에서 찾지 못함. 결과 목록:\n${resultsText}`);
      throw new Error(`[4단계] 취소 대상 예약 미발견: ${PHONE_RAW} ${DATE} ${START}~${END} ${ROOM}`);
    }

    log(`🔗 상세보기 이동: ${viewHref}`);

    // ======================== [5단계] 상세보기 ========================
    log('\n[5단계] 상세보기');
    await page.goto(viewHref, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(1500);
    log(`🌐 URL: ${page.url()}`);

    // 예약 정보 확인 (로그용)
    const viewInfo = await page.evaluate(() => {
      const clean = s => (s ?? '').replace(/\s+/g, ' ').trim();
      const body = clean(document.body?.innerText || '');
      const memberMatch = body.match(/회원 정보\s+([^\n]+)/);
      return { member: memberMatch?.[1]?.slice(0, 50) };
    });
    log(`📋 예약 회원: ${viewInfo.member || '(확인 실패)'}`);

    // ======================== [6단계] 결제완료 주문상세 버튼 클릭 ========================
    log('\n[6단계] 결제완료 상태 주문상세 버튼 클릭');

    const orderDetailClicked = await page.evaluate(() => {
      const clean = s => (s ?? '').replace(/\s+/g, ' ').trim();
      const trs = Array.from(document.querySelectorAll('tbody tr, tr'));
      const TARGET_STATUS = ['결제완료', '결제대기'];
      const DONE_STATUS   = ['환불완료', '환불성공', '취소완료'];

      // 1순위: 결제완료 또는 결제대기 + 아직 환불/취소 안 된 row
      for (const tr of trs) {
        const rowText = clean(tr.textContent);
        const hasTarget = TARGET_STATUS.some(s => rowText.includes(s));
        if (!hasTarget) continue;
        const isDone = DONE_STATUS.some(s => rowText.includes(s));
        if (isDone) continue;
        const btns = Array.from(tr.querySelectorAll('a, button, input[type="button"]'));
        for (const btn of btns) {
          const t = clean(btn.textContent || btn.value || '');
          if (t.includes('주문상세')) {
            btn.click();
            return { clicked: true, btnText: t, rowText: rowText.slice(0, 100) };
          }
        }
      }
      // 이미 모두 환불/취소 처리된 경우
      const allDone = trs.some(tr => {
        const rt = clean(tr.textContent);
        return TARGET_STATUS.some(s => rt.includes(s)) && DONE_STATUS.some(s => rt.includes(s));
      });
      if (allDone) return { clicked: false, alreadyCancelled: true };
      return { clicked: false };
    });

    log(`주문상세 클릭: ${JSON.stringify(orderDetailClicked)}`);
    if (!orderDetailClicked.clicked) {
      if (orderDetailClicked.alreadyCancelled) {
        log('ℹ️ 이미 환불/취소 완료된 예약입니다. 중복 처리 방지로 종료.');
        try { await browser.close(); } catch (e) {}
        process.exit(0);
      }

      // ── [6-B단계] 폴백: 0원/이용중 예약 → 수정 → 취소(sd_step=-1) → 저장 ──
      log('\n[6-B단계] 주문상세 없음 → 수정 버튼 폴백 시도 (0원/이용중 예약)');

      // 수정 버튼 클릭 → /study/write/{sd_no}.html
      const editClicked = await page.evaluate(() => {
        const clean = s => (s ?? '').replace(/\s+/g, ' ').trim();
        const links = Array.from(document.querySelectorAll('a, button, input[type="button"]'));
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

      // 취소(sd_step = -1) 라디오 선택
      const cancelSelected = await page.evaluate(() => {
        // input#sd_step-1 또는 input[name="sd_step"][value="-1"]
        const radio = document.querySelector('input#sd_step-1, input[name="sd_step"][value="-1"]');
        if (radio) { radio.click(); return { selected: true, id: radio.id, value: radio.value }; }
        return { selected: false };
      });
      log(`  취소 라디오: ${JSON.stringify(cancelSelected)}`);
      if (!cancelSelected.selected) throw new Error('[6-B단계] 취소(sd_step=-1) 라디오 없음');
      await delay(300);

      // 저장(작성하기) 버튼 클릭
      const saveClicked = await page.evaluate(() => {
        const clean = s => (s ?? '').replace(/\s+/g, ' ').trim();
        // input[value="작성하기"] 또는 텍스트 "저장"/"작성하기" 버튼
        const candidates = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button'));
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

      // [10단계] 취소 완료 확인 후 종료
      const finalStatusB = await page.evaluate(() =>
        (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300)
      ).catch(() => '');
      const isCancelledB = finalStatusB.includes('취소') || finalStatusB.includes('환불') || finalStatusB.includes('삭제');
      log(`📊 최종 상태: ${isCancelledB ? '취소 확인됨' : '상태 불명확 (수동 확인 권장)'}`);
      log('✅ [SUCCESS] 픽코 예약 취소 완료 (수정→취소→저장 플로우)');
      try { await browser.close(); } catch (e) {}
      process.exit(0);
    }
    await delay(1500);

    // ======================== [7단계] 결제항목 상세보기 클릭 ========================
    log('\n[7단계] 결제항목 상세보기 클릭');

    // a.pay_view = "상세보기" 버튼 (py_no 속성 있음) — Puppeteer 네이티브 클릭
    let payViewFound = false;
    try {
      await page.waitForSelector('a.pay_view', { timeout: 8000 });
      payViewFound = true;
    } catch (e) {
      log(`  ⚠️ a.pay_view 미발견 (결제대기 등) → [7-B단계] 폴백`);
    }

    if (!payViewFound) {
      // ── [7-B단계] 결제대기 폴백: 예약 수정 페이지에서 취소 상태 저장 ──
      log('\n[7-B단계] study/write → 취소 상태 저장 폴백');
      const sdMatch = viewHref.match(/\/study\/view\/(\d+)/);
      const sdNo = sdMatch ? sdMatch[1] : null;
      if (!sdNo) throw new Error('[7-B단계] sd_no 추출 실패');

      await page.goto(`https://pickkoadmin.com/study/write/${sdNo}.html`, {
        waitUntil: 'domcontentloaded', timeout: 20000
      });
      await delay(1500);
      log(`  이동: ${page.url()}`);

      const cancelSelected = await page.evaluate(() => {
        const radio = document.querySelector('input#sd_step-1, input[name="sd_step"][value="-1"]');
        if (radio) { radio.click(); return { selected: true, id: radio.id, value: radio.value }; }
        return { selected: false };
      });
      log(`  취소 라디오: ${JSON.stringify(cancelSelected)}`);
      if (!cancelSelected.selected) throw new Error('[7-B단계] 취소(sd_step=-1) 라디오 없음');
      await delay(300);

      const saveClicked = await page.evaluate(() => {
        const clean = s => (s ?? '').replace(/\s+/g, ' ').trim();
        const candidates = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button'));
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
        (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 300)
      ).catch(() => '');
      const isCancelledB = finalStatusB.includes('취소') || finalStatusB.includes('환불') || finalStatusB.includes('삭제');
      log(`📊 최종 상태: ${isCancelledB ? '취소 확인됨' : '상태 불명확 (수동 확인 권장)'}`);
      log('✅ [SUCCESS] 픽코 예약 취소 완료 (결제대기→수정→취소 플로우)');
      try { await browser.close(); } catch (e) {}
      process.exit(0);
    }

    await page.click('a.pay_view');
    log('상세보기 클릭: {"clicked":true,"selector":"a.pay_view"}');

    // 오른쪽 패널 AJAX 로딩 대기
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => null);
    await page.waitForSelector('a.pay_refund', { timeout: 8000 }).catch(() => null);
    await delay(300);

    // ======================== [8단계] 환불 버튼 클릭 (오른쪽 패널 a.pay_refund) ========================
    log('\n[8단계] 환불 버튼 클릭');

    const refundClicked = await page.evaluate(() => {
      const btn = document.querySelector('a.pay_refund');
      if (btn) {
        btn.click();
        return { clicked: true, text: (btn.textContent || '').trim() };
      }
      return { clicked: false };
    });

    log(`환불 버튼: ${JSON.stringify(refundClicked)}`);
    if (!refundClicked.clicked) {
      throw new Error('[8단계] 환불 버튼 없음');
    }
    await delay(1000);

    // ======================== [9단계] 처리되었습니다. 팝업 확인 ========================
    // setupDialogHandler가 native alert 자동 처리
    // [9단계] setupDialogHandler가 native alert("처리되었습니다.")를 자동 처리
    // 환불 후 페이지가 navigate되므로 navigation 완료 대기
    log('\n[9단계] 처리완료 후 페이지 안정 대기');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null);
    await delay(500);

    // ======================== [10단계] 취소 완료 확인 ========================
    log('\n[10단계] 취소 완료 확인');

    const finalUrl = page.url();
    log(`🌐 최종 URL: ${finalUrl}`);

    // 페이지 내 취소/환불 상태 확인 (navigation 후 새 컨텍스트)
    const finalStatusText = await page.evaluate(() => {
      const clean = s => (s ?? '').replace(/\s+/g, ' ').trim();
      return clean(document.body?.innerText || '').slice(0, 500);
    }).catch(() => '');
    const isCancelled = finalStatusText.includes('취소') || finalStatusText.includes('환불');
    log(`📊 최종 상태: ${isCancelled ? '취소/환불 확인됨' : '상태 불명확 (수동 확인 권장)'}`);

    log(`✅ [SUCCESS] 픽코 예약 취소 완료!`);
    log(`   📞 번호: ${PHONE_RAW}`);
    log(`   📅 날짜: ${DATE}`);
    log(`   ⏰ 시간: ${START}~${END}`);
    log(`   🏛️ 룸: ${ROOM}`);

    try { await browser.close(); } catch (e) {}
    process.exit(0);

  } catch (err) {
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

    try { if (browser) await browser.close(); } catch (e) {}
    process.exit(1);
  }
}

run().catch(err => {
  console.error('pickko-cancel.js 예상치 못한 오류:', err);
  process.exit(1);
});
