#!/usr/bin/env node
/// <reference lib="dom" />
/**
 * init-naver-booking-session.ts — naver-booking-profile 세션 초기화 (1회 실행)
 *
 * dist/ts-runtime/.../pickko-kiosk-monitor.js가 사용하는 naver-booking-profile에 Naver 로그인 세션 저장
 * dist/ts-runtime/.../naver-monitor.js의 naver-profile과 분리 (동시 실행 충돌 방지)
 */
'use strict';

const puppeteer = require('puppeteer');
const path = require('path');
const readline = require('readline');
const { getNaverLaunchOptions, isHeadedMode } = require('../lib/browser');
const { getReservationRuntimeDir, ensureDir } = require('../lib/runtime-paths');

const WORKSPACE = getReservationRuntimeDir();
const NAVER_PROFILE = path.join(WORKSPACE, 'naver-booking-profile');
const BOOKING_URL = 'https://partner.booking.naver.com/bizes/596871/booking-calendar-view';

function waitForEnter(msg) {
  return new Promise<void>((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, () => { rl.close(); resolve(); });
  });
}

(async () => {
  console.log('🔐 naver-booking-profile 세션 초기화');
  console.log(`   Profile: ${NAVER_PROFILE}`);
  console.log(`   URL: ${BOOKING_URL}\n`);
  ensureDir(NAVER_PROFILE);

  if (!isHeadedMode('naver')) {
    console.log('ℹ️ 기본값은 headless입니다. 수동 로그인 초기화는 PLAYWRIGHT_HEADLESS=false 또는 NAVER_HEADLESS=0으로 실행하는 것을 권장합니다.\n');
  }

  const browser = await puppeteer.launch(getNaverLaunchOptions({
    userDataDir: NAVER_PROFILE,
  }));

  const page = await browser.newPage();
  await page.goto(BOOKING_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

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
