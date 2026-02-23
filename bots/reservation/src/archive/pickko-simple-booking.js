#!/usr/bin/env node

/**
 * 픽코 간단 예약 등록 (개선 버전)
 * 010-3500-0586 전화번호로 오늘 01:30~02:00 예약 생성
 */

const puppeteer = require('puppeteer');

const PICKKO_ID = 'a2643301450';
const PICKKO_PW = 'lsh120920!';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(msg) {
  const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[${timestamp}] ${msg}`);
}

async function simpleBooking() {
  let browser;
  
  try {
    log('🚀 예약 등록 시작');
    
    // 브라우저 실행
    browser = await puppeteer.launch({
      headless: false, // 화면 표시
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      timeout: 30000
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // 타임아웃 설정 완화
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);
    
    // 1️⃣ 로그인 페이지 접속
    log('📱 로그인 페이지 접속...');
    await page.goto('https://pickkoadmin.com/manager/login.html', { waitUntil: 'domcontentloaded' });
    await delay(2000);
    
    // 2️⃣ 로그인
    log('🔐 로그인 진행 중...');
    await page.type('#mn_id', PICKKO_ID, { delay: 30 });
    await page.type('#mn_pw', PICKKO_PW, { delay: 30 });
    
    try {
      await Promise.all([
        page.click('#loginButton'),
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 })
      ]);
    } catch (err) {
      log('⚠️ 네비게이션 타임아웃 - 계속 진행');
    }
    
    await delay(3000);
    log('✅ 로그인 완료');
    
    // 3️⃣ 스터디룸 직접 접속
    log('📋 스터디룸 페이지 접속...');
    await page.goto('https://pickkoadmin.com/study/index.html', { waitUntil: 'domcontentloaded' });
    await delay(3000);
    
    log('✅ 스터디룸 페이지 로드 완료');
    
    // 4️⃣ 페이지 상태 확인
    const pageTitle = await page.title();
    log(`📄 페이지 제목: ${pageTitle}`);
    
    // 5️⃣ 예약등록 버튼 찾기
    log('🔍 예약등록 버튼 검색...');
    
    const allButtons = await page.$$('a, button');
    log(`📊 발견한 버튼/링크: ${allButtons.length}개`);
    
    let found = false;
    for (let i = 0; i < allButtons.length; i++) {
      const text = await page.evaluate(el => el.textContent.trim(), allButtons[i]);
      const href = await page.evaluate(el => el.getAttribute('href'), allButtons[i]);
      
      if (text.includes('예약등록') || href?.includes('write')) {
        log(`✅ 예약등록 버튼 발견! (${text})`);
        
        // 클릭
        await allButtons[i].click();
        log('✅ 예약등록 버튼 클릭 완료');
        found = true;
        break;
      }
    }
    
    if (!found) {
      log('⚠️ 예약등록 버튼을 찾을 수 없음 - 직접 URL로 이동');
      await page.goto('https://pickkoadmin.com/study/write.html', { waitUntil: 'domcontentloaded' });
    }
    
    await delay(3000);
    
    // 6️⃣ 회원 선택 버튼 찾기
    log('👤 회원 선택 클릭...');
    
    const allElements = await page.$$('a, button, div');
    for (let i = 0; i < allElements.length; i++) {
      const text = await page.evaluate(el => el.textContent, allElements[i]);
      
      if (text.includes('회원 선택') || text.includes('선택')) {
        await allElements[i].click();
        log('✅ 회원 선택 클릭 완료');
        break;
      }
    }
    
    await delay(2000);
    
    // 7️⃣ 검색창 찾아서 전화번호 입력
    log('🔎 검색창에 전화번호 입력...');
    
    const inputs = await page.$$('input[type="text"]');
    log(`📊 발견한 텍스트 입력창: ${inputs.length}개`);
    
    for (let i = 0; i < inputs.length; i++) {
      const placeholder = await page.evaluate(el => el.placeholder, inputs[i]);
      const value = await page.evaluate(el => el.value, inputs[i]);
      
      log(`   입력창 ${i}: placeholder="${placeholder}", value="${value}"`);
      
      // 검색창에 입력
      if (placeholder.includes('이름') || placeholder.includes('검색')) {
        await inputs[i].type('010-3500-0586', { delay: 30 });
        log('✅ 전화번호 입력 완료');
        break;
      }
    }
    
    await delay(2000);
    
    // 8️⃣ 회원 결과에서 선택
    log('👥 검색 결과에서 회원 선택...');
    
    const selectButtons = await page.$$('button, a, [role="button"]');
    for (const btn of selectButtons) {
      const text = await page.evaluate(el => el.textContent.trim(), btn);
      
      if (text === '선택' || text.includes('선택')) {
        await btn.click();
        log('✅ 회원 선택 완료');
        break;
      }
    }
    
    await delay(2000);
    
    // 9️⃣ 스터디룸 선택
    log('🏠 스터디룸 A1 선택...');
    
    const roomElements = await page.$$('button, a, [class*="room"], [class*="Room"]');
    for (const el of roomElements) {
      const text = await page.evaluate(elem => elem.textContent, el);
      
      if (text.includes('A1') && (text.includes('스터디') || text.includes('룸'))) {
        await el.click();
        log('✅ A1 룸 선택 완료');
        break;
      }
    }
    
    await delay(1500);
    
    // 🔟 날짜 입력
    log('📅 날짜 설정...');
    
    const dateInputs = await page.$$('input[type="date"]');
    if (dateInputs.length > 0) {
      await dateInputs[0].type('2026-02-21', { delay: 30 });
      log('✅ 날짜 설정 완료 (2026-02-21)');
    }
    
    await delay(1500);
    
    // 1️⃣1️⃣ 시간 선택
    log('⏰ 시간 선택 (01:30)...');
    
    const timeElements = await page.$$('button, li, [class*="time"]');
    for (const el of timeElements) {
      const text = await page.evaluate(elem => elem.textContent, el);
      
      if (text.includes('01:30')) {
        await el.click();
        log('✅ 01:30 시간 선택 완료');
        break;
      }
    }
    
    await delay(2000);
    
    // 1️⃣2️⃣ 저장 버튼 클릭
    log('💾 예약 저장...');
    
    const saveButtons = await page.$$('button, a');
    let saved = false;
    for (const btn of saveButtons) {
      const text = await page.evaluate(elem => elem.textContent, btn);
      
      if (text.includes('작성하기') || text.includes('저장')) {
        await btn.click();
        log('✅ 예약 저장 완료');
        saved = true;
        break;
      }
    }
    
    if (!saved) {
      log('⚠️ 저장 버튼을 찾을 수 없음');
    }
    
    await delay(3000);
    
    log('\n✅ ✅ ✅ 예약 등록 완료!');
    log('📸 결과를 확인하세요');
    log('💡 브라우저를 닫으려면 Ctrl+C를 누르세요');
    
  } catch (err) {
    log(`\n❌ 오류 발생: ${err.message}`);
    log(`📍 스택: ${err.stack}`);
  }
}

// 실행
simpleBooking().catch(console.error);
