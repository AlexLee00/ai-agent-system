#!/usr/bin/env node

/**
 * 픽코 직접 URL 방식 예약 등록
 * 직접 write.html로 이동해서 예약 작성
 */

const puppeteer = require('puppeteer');

const PICKKO_ID = 'a2643301450';
const PICKKO_PW = 'lsh120920!';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(msg) {
  const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[${timestamp}] ${msg}`);
}

async function directBooking() {
  let browser;
  
  try {
    log('🚀 직접 예약 등록 시작');
    
    // 브라우저 실행
    browser = await puppeteer.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);
    
    // 1️⃣ 로그인
    log('🔐 로그인 페이지 접속...');
    await page.goto('https://pickkoadmin.com/manager/login.html', { waitUntil: 'domcontentloaded' });
    await delay(2000);
    
    log('📝 자격증 입력...');
    await page.type('#mn_id', PICKKO_ID, { delay: 30 });
    await page.type('#mn_pw', PICKKO_PW, { delay: 30 });
    
    log('🔓 로그인 버튼 클릭...');
    await Promise.all([
      page.click('#loginButton'),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 })
    ]).catch(err => {
      log('⚠️ 네비게이션 에러 무시 - 계속 진행');
    });
    
    await delay(3000);
    log('✅ 로그인 완료');
    
    // 2️⃣ 직접 예약 작성 페이지로 이동
    log('📋 예약 작성 페이지로 직접 이동...');
    await page.goto('https://pickkoadmin.com/study/write.html', { waitUntil: 'domcontentloaded' });
    await delay(3000);
    
    log('✅ 예약 작성 페이지 로드 완료');
    
    // 3️⃣ 페이지 내용 확인
    const content = await page.evaluate(() => {
      return document.body.innerText.substring(0, 500);
    });
    log(`📄 페이지 내용: ${content.substring(0, 100)}...`);
    
    // 4️⃣ "회원 선택" 버튼 클릭
    log('👤 회원 선택 버튼 클릭...');
    
    const clicked = await page.evaluate(() => {
      // 회원 선택 버튼 찾기
      const allElements = document.querySelectorAll('button, a, [role="button"], div');
      
      for (const el of allElements) {
        if (el.textContent.trim().includes('회원 선택')) {
          el.click();
          return true;
        }
      }
      return false;
    });
    
    if (clicked) {
      log('✅ 회원 선택 버튼 클릭 완료');
    } else {
      log('⚠️ 회원 선택 버튼을 찾을 수 없음');
    }
    
    await delay(2000);
    
    // 5️⃣ 검색창에 전화번호 입력
    log('🔎 전화번호 검색...');
    
    const searchSuccess = await page.evaluate((phone) => {
      const inputs = document.querySelectorAll('input[type="text"]');
      
      for (const input of inputs) {
        const placeholder = input.placeholder || '';
        
        // 이름/전화번호 검색창 찾기
        if (placeholder.includes('이름') || placeholder.includes('검색') || placeholder.includes('전화')) {
          input.focus();
          input.value = phone;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        }
      }
      return false;
    }, '010-3500-0586');
    
    if (searchSuccess) {
      log('✅ 전화번호 입력 완료');
    } else {
      log('⚠️ 검색창을 찾을 수 없음 - 모든 input에 시도');
      
      const allInputs = await page.$$('input[type="text"]');
      if (allInputs.length > 0) {
        await allInputs[0].type('010-3500-0586', { delay: 30 });
        log('✅ 첫 번째 입력창에 입력 완료');
      }
    }
    
    await delay(2000);
    
    // 6️⃣ 검색 결과에서 선택
    log('✅ 검색 결과 선택...');
    
    const selectSuccess = await page.evaluate(() => {
      // 선택 버튼 찾기
      const buttons = document.querySelectorAll('button, a, [role="button"]');
      
      for (const btn of buttons) {
        const text = btn.textContent.trim();
        
        if (text === '선택') {
          btn.click();
          return true;
        }
      }
      return false;
    });
    
    if (selectSuccess) {
      log('✅ 회원 선택 완료');
    } else {
      log('⚠️ 선택 버튼을 찾을 수 없음');
    }
    
    await delay(2000);
    
    // 7️⃣ 스터디룸 선택
    log('🏠 스터디룸 선택...');
    
    const roomSuccess = await page.evaluate(() => {
      const elements = document.querySelectorAll('button, a, div, [class*="room"]');
      
      for (const el of elements) {
        const text = el.textContent.trim();
        
        if (text.includes('[4인] 스터디룸A1') || (text.includes('A1') && text.includes('스터디'))) {
          el.click();
          return true;
        }
      }
      return false;
    });
    
    if (roomSuccess) {
      log('✅ A1 룸 선택 완료');
    }
    
    await delay(1500);
    
    // 8️⃣ 날짜 설정
    log('📅 날짜 설정...');
    
    const dateSuccess = await page.evaluate(() => {
      const dateInputs = document.querySelectorAll('input[type="date"]');
      
      if (dateInputs.length > 0) {
        dateInputs[0].value = '2026-02-21';
        dateInputs[0].dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    });
    
    if (dateSuccess) {
      log('✅ 날짜 설정 완료 (2026-02-21)');
    }
    
    await delay(1500);
    
    // 9️⃣ 시간 선택
    log('⏰ 시간 선택 (01:30)...');
    
    const timeSuccess = await page.evaluate(() => {
      const elements = document.querySelectorAll('button, li, div');
      
      for (const el of elements) {
        const text = el.textContent.trim();
        
        if (text.includes('01:30') || text === '01:30~25') {
          el.click();
          return true;
        }
      }
      return false;
    });
    
    if (timeSuccess) {
      log('✅ 시간 선택 완료');
    }
    
    await delay(2000);
    
    // 🔟 저장
    log('💾 예약 저장...');
    
    const saveSuccess = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, a');
      
      for (const btn of buttons) {
        const text = btn.textContent.trim();
        
        if (text.includes('작성하기')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    
    if (saveSuccess) {
      log('✅ 저장 버튼 클릭 완료');
    }
    
    await delay(3000);
    
    log('\n✨ ✨ ✨ 예약 등록 완료! ✨ ✨ ✨');
    log('📍 010-3500-0586 | 2026-02-21 | 01:30~02:00 | A1 룸');
    log('\n💡 Ctrl+C를 눌러 종료하세요');
    
  } catch (err) {
    log(`\n❌ 오류: ${err.message}`);
  }
}

// 실행
directBooking().catch(console.error);
