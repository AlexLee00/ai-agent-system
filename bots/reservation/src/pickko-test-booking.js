#!/usr/bin/env node

/**
 * 픽코 테스트 예약 등록
 * 010-3500-0586 전화번호로 오늘 01:30~02:00 예약 생성
 */

const puppeteer = require('puppeteer');

const PICKKO_ID = 'a2643301450';
const PICKKO_PW = 'lsh120920!';
const PICKKO_URL = 'https://pickkoadmin.com/study/index.html';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(msg) {
  const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[${timestamp}] ${msg}`);
}

async function testBooking() {
  let browser;
  
  try {
    log('🚀 테스트 예약 등록 시작');
    
    // 브라우저 실행
    browser = await puppeteer.launch({
      headless: false, // 헤드리스 해제 - 화면 표시
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // 1️⃣ 픽코 접속
    log('📱 픽코 접속 중...');
    await page.goto('https://pickkoadmin.com/manager/login.html', { waitUntil: 'networkidle2', timeout: 15000 });
    
    await delay(3000);
    
    // 2️⃣ 로그인
    log('🔐 로그인 중...');
    await page.type('#mn_id', PICKKO_ID, { delay: 50 });
    await page.type('#mn_pw', PICKKO_PW, { delay: 50 });
    
    await Promise.all([
      page.click('#loginButton'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {
        log('⚠️ 로그인 페이지 이동 중...');
      })
    ]);
    
    log('✅ 로그인 완료');
    await delay(4000);
    
    // 3️⃣ 스터디룸 메뉴 클릭
    log('📋 스터디룸 메뉴 클릭...');
    try {
      await page.click('a[href*="/study"]');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {
        log('⚠️ 페이지 이동 대기 중...');
      });
    } catch (err) {
      log(`⚠️ 스터디룸 메뉴 클릭 오류: ${err.message}`);
    }
    
    log('✅ 스터디룸 페이지 로드 완료');
    await delay(3000);
    
    // 4️⃣ 예약등록 버튼 클릭
    log('➕ 예약등록 버튼 클릭...');
    
    // 예약등록 버튼 찾기 (여러 방법 시도)
    let clicked = false;
    try {
      await page.click('a:contains("예약등록")');
      clicked = true;
    } catch (err) {
      try {
        const buttons = await page.$$('a, button');
        for (const btn of buttons) {
          const text = await page.evaluate(el => el.textContent, btn);
          if (text.includes('예약등록')) {
            await btn.click();
            clicked = true;
            break;
          }
        }
      } catch (err2) {
        log('⚠️ 예약등록 버튼 자동 클릭 실패 - 수동 대기 중');
      }
    }
    
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {
      log('⚠️ 페이지 이동 없음 - 계속 진행');
    });
    
    await delay(2000);
    
    // 5️⃣ 우측 검색창에 전화번호 입력
    log('🔍 회원 검색...');
    const searchInputs = await page.$$('input[type="text"]');
    
    let foundSearch = false;
    for (const input of searchInputs) {
      const placeholder = await page.evaluate(el => el.placeholder, input);
      if (placeholder && placeholder.includes('이름')) {
        await input.type('010-3500-0586', { delay: 50 });
        foundSearch = true;
        log('✅ 전화번호 입력 완료');
        break;
      }
    }
    
    if (!foundSearch) {
      log('⚠️ 검색창을 찾을 수 없음 - 첫 번째 텍스트 입력창 사용');
      if (searchInputs.length > 0) {
        await searchInputs[0].type('010-3500-0586', { delay: 50 });
      }
    }
    
    await delay(1500);
    
    // 6️⃣ 회원 선택
    log('👤 회원 선택...');
    const selectBtns = await page.$$('button, [role="button"], a');
    let memberSelected = false;
    
    for (const btn of selectBtns) {
      const text = await page.evaluate(el => el.textContent, btn);
      if (text.includes('선택')) {
        await btn.click();
        memberSelected = true;
        log('✅ 회원 선택 완료');
        break;
      }
    }
    
    if (!memberSelected) {
      log('⚠️ 선택 버튼을 찾을 수 없음');
    }
    
    await delay(2000);
    
    // 7️⃣ 스터디룸 선택 (A1)
    log('🏠 스터디룸 A1 선택...');
    const roomBtns = await page.$$('button, a, [class*="room"]');
    let roomSelected = false;
    
    for (const btn of roomBtns) {
      const text = await page.evaluate(el => el.textContent, btn);
      if (text.includes('A1')) {
        await btn.click();
        roomSelected = true;
        log('✅ A1 룸 선택 완료');
        break;
      }
    }
    
    if (!roomSelected) {
      log('⚠️ 룸 선택 버튼을 찾을 수 없음');
    }
    
    await delay(1500);
    
    // 8️⃣ 날짜 설정 (오늘: 2026-02-21)
    log('📅 날짜 설정...');
    const dateInputs = await page.$$('input[type="date"], input[placeholder*="일"]');
    if (dateInputs.length > 0) {
      await dateInputs[0].type('2026-02-21', { delay: 50 });
      log('✅ 날짜 설정 완료');
    }
    
    await delay(1500);
    
    // 9️⃣ 시간 선택 (01:30~02:00)
    log('⏰ 시간 선택 (01:30 ~ 02:00)...');
    const timeItems = await page.$$('button, li, [class*="time"]');
    let timeSelected = false;
    
    for (const item of timeItems) {
      const text = await page.evaluate(el => el.textContent, item);
      
      // 01:30 시간 찾기
      if (text.includes('01:30')) {
        await item.click();
        log('✅ 01:30 시간 선택 완료');
        timeSelected = true;
        break;
      }
    }
    
    if (!timeSelected) {
      log('⚠️ 시간 선택 버튼을 찾을 수 없음');
    }
    
    await delay(1500);
    
    // 🔟 작성하기 버튼 클릭
    log('💾 예약 저장...');
    const submitBtns = await page.$$('button, a');
    let submitted = false;
    
    for (const btn of submitBtns) {
      const text = await page.evaluate(el => el.textContent, btn);
      if (text.includes('작성하기')) {
        await btn.click();
        submitted = true;
        log('✅ 예약 저장 클릭 완료');
        break;
      }
    }
    
    if (!submitted) {
      log('⚠️ 작성하기 버튼을 찾을 수 없음');
    }
    
    await delay(3000);
    
    log('✅ 테스트 예약 등록 완료!');
    log('📸 브라우저는 계속 열려있습니다 (확인 후 닫으세요)');
    
  } catch (err) {
    log(`❌ 오류 발생: ${err.message}`);
  } finally {
    // 브라우저 자동 종료하지 않음 - 사용자가 확인 후 닫을 수 있도록
    log('💡 팁: Ctrl+C를 눌러 종료할 수 있습니다');
  }
}

testBooking();
