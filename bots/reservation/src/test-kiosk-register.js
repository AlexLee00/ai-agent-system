#!/usr/bin/env node
/**
 * test-kiosk-register.js — 키오스크 예약 테스트 데이터 삽입
 *
 * pickko-accurate.js와 동일하지만 결제금액을 0으로 변경하지 않고 그대로 결제
 * → 이용금액 > 0 인 예약을 만들어 pickko-kiosk-monitor.js 테스트에 사용
 *
 * 테스트 후 반드시 예약 취소 처리 필요
 *
 * 사용법:
 *   node src/test-kiosk-register.js --date=2026-02-25 --start=19:00 --end=20:00 --room=A1
 */

const puppeteer = require('puppeteer');
const { delay, log } = require('../lib/utils');
const { loadSecrets } = require('../lib/secrets');
const { parseArgs } = require('../lib/args');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../lib/browser');
const { loginToPickko } = require('../lib/pickko');

const SECRETS = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;

const ARGS = parseArgs(process.argv);
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

const DATE = ARGS.date || today;
const START_TIME = ARGS.start || '19:00';
const END_TIME = ARGS.end || '20:00';
const ROOM = ARGS.room || 'A1';
// 화이트리스트 번호 사용 (이재룡 - 사장님)
const TEST_PHONE = '01035000586';
const CUSTOMER_NAME = '테스트키오스크';

const ROOM_IDS = { A1: '206482', A2: '206450', B: '206487' };

log(`🧪 테스트 키오스크 예약 등록 시작`);
log(`   날짜: ${DATE}, 시간: ${START_TIME}~${END_TIME}, 룸: ${ROOM}, 전화: ${TEST_PHONE}`);
log(`   ⚠️  이용금액을 0으로 변경하지 않고 실제 금액으로 결제합니다`);
log(`   ⚠️  테스트 완료 후 반드시 예약 취소 처리하세요`);

// 시간 슬롯 생성 (30분 단위)
function buildSlots(start, end) {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const slots = [];
  for (let min = sh * 60 + sm; min < eh * 60 + em; min += 30) {
    slots.push(`${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`);
  }
  return slots;
}

const TIME_SLOTS = buildSlots(START_TIME, END_TIME);
log(`   슬롯: [${TIME_SLOTS.join(', ')}] (${TIME_SLOTS.length}개)`);

async function main() {
  const browser = await puppeteer.launch(getPickkoLaunchOptions());
  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  page.setDefaultTimeout(30000);
  setupDialogHandler(page, log);

  try {
    // 1. 로그인
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log(`✅ 로그인: ${page.url()}`);

    // 2. 예약 등록 페이지 이동
    await page.goto('https://pickkoadmin.com/study/write.html', { waitUntil: 'networkidle2' });
    await delay(1500);

    // 3. 회원 검색 (전화번호)
    log(`\n[회원 검색] ${TEST_PHONE}`);
    const phone1 = TEST_PHONE.slice(0, 3);
    const phone2 = TEST_PHONE.slice(3, 7);
    const phone3 = TEST_PHONE.slice(7);

    const ph1El = await page.$('input[name="mb_phone1"]') || await page.$('input[name="phone1"]');
    const ph2El = await page.$('input[name="mb_phone2"]') || await page.$('input[name="phone2"]');
    const ph3El = await page.$('input[name="mb_phone3"]') || await page.$('input[name="phone3"]');

    if (ph1El) { await ph1El.click({ clickCount: 3 }); await ph1El.type(phone1, { delay: 50 }); }
    if (ph2El) { await ph2El.click({ clickCount: 3 }); await ph2El.type(phone2, { delay: 50 }); }
    if (ph3El) { await ph3El.click({ clickCount: 3 }); await ph3El.type(phone3, { delay: 50 }); }
    await delay(300);

    // 회원 검색 버튼 클릭
    const searchBtn = await page.$('button[onclick*="mb_search"], input[value*="검색"], a[onclick*="search"]');
    if (searchBtn) {
      await searchBtn.click();
      await delay(2000);
    }

    log(`✅ 회원 검색 완료`);

    // 4. 룸 선택
    log(`\n[룸 선택] ${ROOM}`);
    const roomSelected = await page.evaluate((room, roomIds) => {
      const roomId = roomIds[room];
      const btns = document.querySelectorAll('button, input[type="button"], td, a');
      for (const el of btns) {
        const text = (el.textContent || '').trim();
        const val = el.getAttribute('value') || '';
        const onclick = el.getAttribute('onclick') || '';
        if (text.includes(room) || onclick.includes(roomId) || val === roomId) {
          if (el.offsetParent !== null) {
            el.click();
            return { clicked: true, text, onclick: onclick.slice(0, 50) };
          }
        }
      }
      return { clicked: false };
    }, ROOM, ROOM_IDS);
    log(`  룸 선택: ${JSON.stringify(roomSelected)}`);
    await delay(1500);

    // 5. 날짜 설정
    log(`\n[날짜 설정] ${DATE}`);
    const dateSet = await page.evaluate((dateStr) => {
      const dateInputs = document.querySelectorAll('input[type="text"][id*="date"], input[type="text"][name*="date"], input[id*="dp"]');
      for (const el of dateInputs) {
        if (el.offsetParent !== null) {
          el.value = dateStr;
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { set: true, id: el.id, name: el.name };
        }
      }
      return { set: false };
    }, DATE);
    log(`  날짜: ${JSON.stringify(dateSet)}`);
    await delay(1000);

    // 6. 시간 슬롯 선택
    log(`\n[시간 슬롯 선택] ${TIME_SLOTS.join(', ')}`);
    for (const slot of [TIME_SLOTS[0], TIME_SLOTS[TIME_SLOTS.length - 1]]) {
      const clicked = await page.evaluate((timeSlot) => {
        const els = document.querySelectorAll('td, button, a, span');
        for (const el of els) {
          const text = (el.textContent || '').replace(/\s+/g, '').trim();
          if (text === timeSlot && el.offsetParent !== null) {
            el.click();
            return { clicked: true, text };
          }
        }
        return { clicked: false, timeSlot };
      }, slot);
      log(`  슬롯 ${slot}: ${JSON.stringify(clicked)}`);
      await delay(500);
    }

    // 7. 저장 버튼 클릭
    log(`\n[저장]`);
    const saveBtn = await page.$('input[value*="저장"], button:contains("저장"), input[type="submit"]');
    if (saveBtn) {
      await Promise.all([
        saveBtn.click(),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => null)
      ]);
    }
    await delay(2000);
    log(`  현재 URL: ${page.url()}`);

    // 8. 결제 페이지 확인 + 결제 (금액 0으로 변경 안 함)
    log(`\n[결제] 이용금액 그대로 결제`);

    const payInfo = await page.evaluate(() => {
      const priceText = (document.querySelector('#od_total_price3, .total-price, [class*="total"]')?.textContent || '').trim();
      const payBtn = document.querySelector('#pay_order, button[onclick*="pay"], input[value*="결제"]');
      return { priceText, hasPayBtn: !!payBtn };
    });
    log(`  결제 정보: ${JSON.stringify(payInfo)}`);

    // 결제 버튼 클릭 (금액 변경 없이)
    const payClicked = await page.evaluate(() => {
      const payBtn = document.querySelector('#pay_order')
        || document.querySelector('button[onclick*="pay"]')
        || document.querySelector('input[value*="결제"]');
      if (payBtn && payBtn.offsetParent !== null) {
        payBtn.click();
        return { clicked: true };
      }
      return { clicked: false };
    });
    log(`  결제 클릭: ${JSON.stringify(payClicked)}`);
    await delay(3000);

    const finalUrl = page.url();
    log(`\n✅ 테스트 예약 등록 완료`);
    log(`   최종 URL: ${finalUrl}`);
    log(`   ⚠️  픽코 admin에서 예약 확인 후 테스트 종료 시 취소 처리하세요`);

    // 브라우저 열어둠 (사용자 확인용)
    log(`\n브라우저를 열어둡니다. Ctrl+C로 종료하세요.`);
    await new Promise(() => {}); // 무한 대기

  } catch (e) {
    log(`❌ 오류: ${e.message}`);
    await browser.close();
    process.exit(1);
  }
}

main();
