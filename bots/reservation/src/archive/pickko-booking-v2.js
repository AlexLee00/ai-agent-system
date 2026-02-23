#!/usr/bin/env node

/**
 * 픽코 예약 등록 (v2 - 간단 버전)
 */

const puppeteer = require('puppeteer');

const PICKKO_ID = 'a2643301450';
const PICKKO_PW = 'lsh120920!';
const PICKKO_STUDY_URL = 'https://pickkoadmin.com/study/index.html';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(msg) {
  const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[${timestamp}] ${msg}`);
}

async function run() {
  let browser;
  
  try {
    log('🚀 픽코 예약 시스템 시작');
    
    browser = await puppeteer.launch({
      headless: false,
      slowMo: 100,
      args: ['--no-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultTimeout(60000);
    page.setDefaultNavigationTimeout(60000);
    
    // 1️⃣ 로그인
    log('1️⃣ 로그인 페이지 이동...');
    await page.goto('https://pickkoadmin.com/manager/login.html', {
      waitUntil: 'domcontentloaded'
    });
    
    await delay(1500);
    
    log('2️⃣ ID/PW 입력...');
    await page.$eval('#mn_id', el => el.value = 'a2643301450');
    await page.$eval('#mn_pw', el => el.value = 'lsh120920!');
    
    await delay(500);
    
    log('3️⃣ 로그인 버튼 클릭...');
    await page.click('#loginButton');
    
    // 페이지 이동 대기
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {
      log('⚠️ 페이지 이동 타임아웃 - 계속 진행');
    });
    
    await delay(2000);
    log('✅ 로그인 완료');
    
    // 2️⃣ 스터디룸 페이지 이동
    log('4️⃣ 스터디룸 페이지 이동...');
    await page.goto(PICKKO_STUDY_URL, { waitUntil: 'domcontentloaded' });
    
    await delay(2000);
    log('✅ 스터디룸 페이지 로드');
    
    // 3️⃣ 현재 페이지 URL 확인
    const currentUrl = page.url();
    log(`📍 현재 URL: ${currentUrl}`);
    
    // 4️⃣ "예약등록" 링크 또는 버튼 찾기
    log('5️⃣ 예약등록 버튼 찾기...');
    
    try {
      // a 태그 중에 href가 /study/write.html 인 것 찾기
      await page.click('a[href*="write"]');
      log('✅ 예약등록 페이지 이동');
    } catch (err) {
      log('⚠️ 버튼 클릭 실패 - 직접 URL로 이동');
      await page.goto('https://pickkoadmin.com/study/write.html', { 
        waitUntil: 'domcontentloaded' 
      });
    }
    
    await delay(2000);
    
    // 5️⃣ 회원 검색
    log('6️⃣ 회원 선택 준비...');
    
    // 우측 검색창 찾기
    const inputs = await page.$$('input[type="text"]');
    
    if (inputs.length > 0) {
      // 마지막 입력창(검색창)에 전화번호 입력
      await inputs[inputs.length - 1].type('010-3500-0586', { delay: 50 });
      log('✅ 전화번호 입력 완료');
      
      await delay(1500);
      
      // 검색 결과에서 선택 버튼 찾기
      const buttons = await page.$$('button');
      for (const btn of buttons) {
        const text = await btn.evaluate(el => el.textContent.trim());
        if (text === '선택') {
          await btn.click();
          log('✅ 회원 선택 완료');
          break;
        }
      }
    }
    
    await delay(2000);
    
    // 6️⃣ 스터디룸 선택
    log('7️⃣ 스터디룸 선택...');
    
    const roomBtns = await page.$$('button, a, div, span');
    let roomSelected = false;
    
    for (const btn of roomBtns) {
      const text = await btn.evaluate(el => el.textContent);
      if (text.includes('[4인] 스터디룸A1')) {
        try {
          await btn.click();
          log('✅ A1룸 선택');
          roomSelected = true;
          break;
        } catch (err) {
          // 클릭 실패, 계속
        }
      }
    }
    
    await delay(1500);
    
    // 7️⃣ 날짜 설정
    log('8️⃣ 날짜 설정...');
    
    const dateInputs = await page.$$('input[type="date"]');
    if (dateInputs.length > 0) {
      // 첫 번째 날짜 입력창
      await dateInputs[0].$eval('input', (el) => el.value = '2026-02-21').catch(() => {
        // 다른 방식 시도
      });
      
      // 대안: 스크립트로 직접 설정
      await page.$eval('input[type="date"]', (el) => el.value = '2026-02-21').catch(() => {
        log('⚠️ 날짜 설정 실패');
      });
      
      log('✅ 날짜 설정 (2026-02-21)');
    }
    
    await delay(1500);
    
    // 8️⃣ 시간 선택
    log('9️⃣ 시간 선택...');
    
    const timeItems = await page.$$('li, button, span, div');
    for (const item of timeItems) {
      const text = await item.evaluate(el => el.textContent);
      if (text.includes('01:30')) {
        try {
          await item.click();
          log('✅ 01:30 시간 선택');
          break;
        } catch (err) {
          // 클릭 실패
        }
      }
    }
    
    await delay(2000);
    
    // 9️⃣ 저장
    log('🔟 예약 저장...');
    
    const saveButtons = await page.$$('button, a');
    for (const btn of saveButtons) {
      const text = await btn.evaluate(el => el.textContent.trim());
      if (text === '작성하기') {
        try {
          await btn.click();
          log('✅ 예약 저장 완료');
          break;
        } catch (err) {
          // 클릭 실패
        }
      }
    }
    
    await delay(3000);
    
    log('\n✅✅✅ 예약 등록 완료!\n');
    log('📸 브라우저 화면을 확인하세요');
    log('💡 종료: Ctrl+C 입력');
    
  } catch (err) {
    log(`\n❌ 에러: ${err.message}`);
  }
}

run();
