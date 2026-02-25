#!/usr/bin/env node
/**
 * init-naver-booking-session.js — naver-booking-profile 세션 초기화 (1회 실행)
 *
 * pickko-kiosk-monitor.js가 사용하는 naver-booking-profile에 Naver 로그인 세션 저장
 * naver-monitor.js의 naver-profile과 분리 (동시 실행 충돌 방지)
 *
 * 사용법:
 *   node src/init-naver-booking-session.js
 *
 * 절차:
 *   1. 브라우저 열림 → partner.booking.naver.com으로 이동
 *   2. 수동으로 네이버 로그인 (아이디/비밀번호 + 2단계 인증)
 *   3. 캘린더 화면이 보이면 Enter 키 입력 → 세션 저장 완료
 */

const puppeteer = require('puppeteer');
const path = require('path');
const readline = require('readline');

const WORKSPACE = path.join(process.env.HOME, '.openclaw', 'workspace');
// naver-monitor.js와 동일한 naver-profile 사용 (CDP 새 탭 연결 시 같은 세션 공유)
const NAVER_PROFILE = path.join(WORKSPACE, 'naver-profile');
const BOOKING_URL = 'https://partner.booking.naver.com/bizes/596871/booking-calendar-view';

function waitForEnter(msg) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, () => { rl.close(); resolve(); });
  });
}

(async () => {
  console.log('🔐 naver-booking-profile 세션 초기화');
  console.log(`   Profile: ${NAVER_PROFILE}`);
  console.log(`   URL: ${BOOKING_URL}\n`);

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null,
    userDataDir: NAVER_PROFILE,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-position=0,25',
      '--window-size=2294,1380'
    ]
  });

  const page = await browser.newPage();
  await page.goto(BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // 이미 로그인된 경우 확인
  await new Promise(r => setTimeout(r, 2000));
  const alreadyIn = await page.evaluate(() => {
    const t = document.body?.innerText || '';
    return t.includes('예약') || document.querySelector('[class*="Calendar"]') !== null;
  });

  if (alreadyIn) {
    console.log('✅ 이미 로그인 상태입니다!');
    console.log('   세션이 naver-booking-profile에 저장되어 있습니다.');
  } else {
    console.log('⚠️  로그인이 필요합니다.');
    console.log('   브라우저에서 네이버 로그인을 진행해주세요.');
    console.log('   (아이디/비밀번호 입력 + 2단계 인증 완료)\n');
    await waitForEnter('   → 캘린더 화면이 보이면 [Enter]를 눌러주세요: ');
  }

  // 세션 저장 확인
  const sessionOk = await page.evaluate(() => {
    const t = document.body?.innerText || document.body?.textContent || '';
    return t.includes('예약') || document.querySelector('[class*="Calendar"]') !== null
      || window.location.href.includes('booking-calendar');
  });

  if (sessionOk) {
    console.log('\n✅ 세션 초기화 완료!');
    console.log('   이제 pickko-kiosk-monitor.js가 자동으로 로그인됩니다.');
    console.log('   launchd가 30분 주기로 자동 실행됩니다.');
  } else {
    console.log('\n⚠️  세션 확인 실패. 로그인 상태를 다시 확인해주세요.');
  }

  await browser.close();
  process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
