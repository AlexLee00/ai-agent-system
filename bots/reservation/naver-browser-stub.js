/**
 * naver-browser-stub.js — Phase 3 테스트용 최소 브라우저 스텁
 * naver-profile Chrome을 실행하고 wsEndpoint를 저장 후 대기
 * (naver-monitor 없이 Phase 3 독립 테스트 가능)
 *
 * 사용: node naver-browser-stub.js
 * 종료: Ctrl+C
 */
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const WORKSPACE = path.join(process.env.HOME, '.openclaw', 'workspace');
const NAVER_PROFILE = path.join(WORKSPACE, 'naver-profile');
const NAVER_WS_FILE = path.join(WORKSPACE, 'naver-monitor-ws.txt');
const BOOKING_URL = 'https://partner.booking.naver.com/bizes/596871/booking-calendar-view';

(async () => {
  console.log('🚀 naver-browser-stub 시작');
  console.log(`   Profile: ${NAVER_PROFILE}`);

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

  // wsEndpoint 저장
  fs.writeFileSync(NAVER_WS_FILE, browser.wsEndpoint(), 'utf8');
  console.log(`📡 CDP 엔드포인트 저장: ${NAVER_WS_FILE}`);
  console.log(`   ${browser.wsEndpoint()}`);

  // booking URL로 이동해서 세션 활성화
  const page = await browser.newPage();
  await page.goto(BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await new Promise(r => setTimeout(r, 3000));

  const status = await page.evaluate(() => {
    const t = document.body?.innerText || '';
    return {
      url: window.location.href.slice(0, 80),
      loggedIn: t.includes('예약') || document.querySelector('[class*="calendar"], [class*="Calendar"]') !== null
    };
  });

  console.log(`\n✅ booking.naver.com 상태: ${JSON.stringify(status)}`);

  if (status.loggedIn) {
    console.log('✅ 로그인 확인됨. kiosk-monitor 실행 가능.');
  } else {
    console.log('⚠️  로그인 안됨. 브라우저에서 수동 로그인 필요.');
  }

  console.log('\n⏳ 브라우저 유지 중... kiosk-monitor 테스트 후 Ctrl+C로 종료');

  // 종료 시 WS 파일 삭제
  process.on('SIGINT', () => {
    try { fs.unlinkSync(NAVER_WS_FILE); } catch (e) {}
    console.log('\n✅ 종료');
    browser.close().finally(() => process.exit(0));
  });

  // 브라우저 유지
  await new Promise(() => {}); // 무한 대기
})().catch(e => { console.error('❌', e.message); process.exit(1); });
