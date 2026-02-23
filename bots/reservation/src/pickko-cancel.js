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
const { delay, log } = require('../lib/utils');
const { loadSecrets } = require('../lib/secrets');
const { parseArgs } = require('../lib/args');
const { formatPhone, toKoreanTime, pickkoEndTime } = require('../lib/formatting');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../lib/browser');
const { loginToPickko } = require('../lib/pickko');

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

    // 전화번호 입력 (하이픈 포함 형식)
    await page.$eval('input[name="mb_phone"]', (el, phone) => {
      el.value = phone;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }, PHONE_FORMATTED);
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

    // 검색 버튼 클릭
    await Promise.all([
      page.click('input[type="submit"].btn_box'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null)
    ]);
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

    // ======================== [6단계] 수정 버튼 클릭 ========================
    log('\n[6단계] 수정 버튼 클릭');

    const modifyHref = await page.evaluate(() => {
      const link = document.querySelector('a[href*="/study/write/"]');
      return link ? link.href : null;
    });

    if (!modifyHref) {
      throw new Error('[6단계] 수정 버튼(a[href*="/study/write/"]) 없음');
    }

    log(`✏️ 수정 폼 이동: ${modifyHref}`);
    await page.goto(modifyHref, { waitUntil: 'networkidle2', timeout: 20000 });
    await delay(2000);
    log(`🌐 URL: ${page.url()}`);

    // ======================== [7단계] 현재 상태 확인 ========================
    log('\n[7단계] 현재 상태 확인');
    const currentStep = await page.evaluate(() => {
      const checked = document.querySelector('input[name="sd_step"]:checked');
      const label = document.querySelector(`label[for="${checked?.id}"]`);
      return { value: checked?.value, label: label?.textContent?.trim() };
    });
    log(`📊 현재 상태: value=${currentStep?.value} (${currentStep?.label})`);

    if (currentStep?.value === '-1') {
      log('ℹ️ 이미 취소 상태입니다. 중복 처리 방지로 종료.');
      try { await browser.close(); } catch (e) {}
      process.exit(0);
    }

    // ======================== [8단계] 취소 상태 선택 ========================
    log('\n[8단계] 취소(sd_step=-1) 선택');

    const cancelSelected = await page.evaluate(() => {
      const radio = document.querySelector('input#sd_step-1');
      if (!radio) return false;
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
      radio.dispatchEvent(new Event('click', { bubbles: true }));
      return true;
    });

    if (!cancelSelected) {
      throw new Error('[8단계] 취소 라디오(input#sd_step-1) 없음');
    }

    // 클릭으로도 한 번 더 확실히
    try {
      const radioHandle = await page.$('input#sd_step-1');
      if (radioHandle) {
        const box = await radioHandle.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        }
      }
    } catch (e) { /* 무시 */ }

    await delay(300);

    // 최종 확인
    const afterSelect = await page.evaluate(() => {
      const radio = document.querySelector('input#sd_step-1');
      return { checked: radio?.checked, value: radio?.value };
    });
    log(`✅ 취소 라디오 상태: ${JSON.stringify(afterSelect)}`);

    if (!afterSelect.checked) {
      throw new Error('[8단계] 취소 라디오 선택 실패 (checked=false)');
    }

    // ======================== [9단계] 작성하기 클릭 ========================
    log('\n[9단계] 작성하기 클릭');

    await Promise.all([
      page.click('input[type="submit"][value="작성하기"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null)
    ]);
    await delay(2000);

    const finalUrl = page.url();
    log(`🌐 제출 후 URL: ${finalUrl}`);

    // ======================== [10단계] 완료 확인 ========================
    log('\n[10단계] 취소 완료 확인');

    // view 페이지로 돌아오거나, 현재 URL이 modify가 아니면 성공으로 판단
    const isSuccess = finalUrl.includes('/study/view/') ||
                      finalUrl.includes('/study/index.html') ||
                      !finalUrl.includes('/study/write/');

    if (isSuccess) {
      // view 페이지로 돌아왔으면 상태 재확인
      if (finalUrl.includes('/study/view/')) {
        const statusText = await page.evaluate(() => {
          const clean = s => (s ?? '').replace(/\s+/g, ' ').trim();
          return clean(document.body?.innerText || '').slice(0, 500);
        });
        const isCancelled = statusText.includes('취소');
        log(`📊 최종 상태 확인: ${isCancelled ? '취소 확인됨' : '상태 불명확'}`);
      }

      log(`✅ [SUCCESS] 픽코 예약 취소 완료!`);
      log(`   📞 번호: ${PHONE_RAW}`);
      log(`   📅 날짜: ${DATE}`);
      log(`   ⏰ 시간: ${START}~${END}`);
      log(`   🏛️ 룸: ${ROOM}`);
    } else {
      log(`⚠️ [WARNING] 취소 완료 확인 불명확 (URL: ${finalUrl})`);
    }

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
