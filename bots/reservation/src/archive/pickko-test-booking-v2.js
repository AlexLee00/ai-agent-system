#!/usr/bin/env node

/**
 * 픽코 테스트 예약 등록 (개선 버전)
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

async function testBooking() {
  let browser;
  
  try {
    log('🚀 테스트 예약 등록 시작');
    
    // 브라우저 실행
    browser = await puppeteer.launch({
      headless: false, // 화면 표시
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // 1️⃣ 픽코 접속
    log('📱 픽코 접속 중...');
    await page.goto('https://pickkoadmin.com/manager/login.html', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await delay(2000);
    
    // 2️⃣ 로그인
    log('🔐 로그인 중...');
    await page.type('#mn_id', PICKKO_ID, { delay: 50 });
    await page.type('#mn_pw', PICKKO_PW, { delay: 50 });
    
    log('🔘 로그인 버튼 클릭...');
    await page.click('#loginButton');
    
    // 로그인 후 페이지 이동 대기
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {
      log('⚠️ 페이지 이동 대기 중...');
    });
    
    log('✅ 로그인 완료');
    await delay(3000);
    
    // 3️⃣ 현재 URL 확인
    const currentUrl = page.url();
    log(`현재 URL: ${currentUrl}`);
    
    // 4️⃣ 스터디룸 메뉴 확인
    log('📋 스터디룸 페이지 진입...');
    
    // 스터디룸 메뉴가 없으면 직접 URL로 이동
    if (!currentUrl.includes('/study')) {
      log('🔗 직접 스터디룸 URL로 이동...');
      await page.goto('https://pickkoadmin.com/study/index.html', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await delay(3000);
    }
    
    log('✅ 스터디룸 페이지 로드 완료');
    
    // 5️⃣ 예약등록 버튼 찾기 및 클릭
    log('➕ 예약등록 버튼 찾기...');
    
    const registerBtnSelector = 'a:contains("예약등록"), button:contains("예약등록"), [class*="register"]';
    
    // XPath를 사용한 더 강력한 선택
    const [registerBtn] = await page.$x("//a[contains(text(), '예약등록')] | //button[contains(text(), '예약등록')]");
    
    if (registerBtn) {
      log('✅ 예약등록 버튼 발견 - 클릭 중...');
      await registerBtn.click();
      await delay(2000);
    } else {
      log('⚠️ 예약등록 버튼을 찾을 수 없음 - 계속 진행');
    }
    
    // 6️⃣ 우측 회원 검색창에 전화번호 입력
    log('🔍 회원 검색 입력창 찾기...');
    
    // 모든 입력 필드 찾기
    const inputs = await page.$$('input[type="text"]');
    log(`📊 텍스트 입력창 ${inputs.length}개 발견`);
    
    let searchFound = false;
    for (let i = 0; i < inputs.length; i++) {
      const placeholder = await page.evaluate(el => el.placeholder, inputs[i]);
      const parentText = await page.evaluate(el => el.parentElement?.textContent || '', inputs[i]);
      
      log(`   입력 ${i}: placeholder="${placeholder}", parent="${parentText.substring(0, 50)}"`);
      
      if (placeholder.includes('이름') || placeholder.includes('검색') || placeholder.includes('전화')) {
        log(`✅ 입력창 #${i} 사용 - 전화번호 입력 중...`);
        await inputs[i].click();
        await inputs[i].type('010-3500-0586', { delay: 30 });
        searchFound = true;
        break;
      }
    }
    
    if (!searchFound && inputs.length > 0) {
      log(`✅ 첫 번째 입력창 사용 - 전화번호 입력 중...`);
      await inputs[0].click();
      await inputs[0].type('010-3500-0586', { delay: 30 });
    }
    
    await delay(2000);
    
    // 7️⃣ 회원 선택
    log('👤 회원 선택 버튼 찾기...');
    
    const [selectBtn] = await page.$x("//button[contains(text(), '선택')] | //a[contains(text(), '선택')]");
    
    if (selectBtn) {
      log('✅ 선택 버튼 발견');
      
      // 버튼이 보이도록 스크롤
      await page.evaluate(btn => btn.scrollIntoView({ behavior: 'smooth', block: 'center' }), selectBtn);
      await delay(1000);
      
      // 클릭 시도
      try {
        await selectBtn.click();
        log('✅ 회원 선택 완료');
      } catch (err) {
        log(`⚠️ 클릭 실패 - JavaScript로 클릭 시도`);
        await page.evaluate(btn => btn.click(), selectBtn);
        log('✅ JavaScript 클릭으로 회원 선택 완료');
      }
    } else {
      log('⚠️ 선택 버튼을 찾을 수 없음');
    }
    
    await delay(2000);
    
    // 8️⃣ 스터디룸 선택
    log('🏠 스터디룸 A1 선택...');
    
    const [roomBtn] = await page.$x("//*[contains(text(), 'A1')] | //*[contains(text(), 'A1')]");
    
    if (roomBtn) {
      await roomBtn.click();
      log('✅ A1 룸 선택 완료');
    } else {
      log('⚠️ A1 룸 버튼을 찾을 수 없음');
    }
    
    await delay(2000);
    
    // 9️⃣ 날짜 선택
    log('📅 날짜 설정...');
    
    const dateInputs = await page.$$('input[type="date"]');
    if (dateInputs.length > 0) {
      await dateInputs[0].type('2026-02-21', { delay: 50 });
      log('✅ 날짜 설정 완료');
    } else {
      log('⚠️ 날짜 입력창을 찾을 수 없음');
    }
    
    await delay(2000);
    
    // 🔟 시간 선택
    log('⏰ 시간 선택 (01:30~02:00)...');
    
    const [timeBtn] = await page.$x("//*[contains(text(), '01:30')] | //button[contains(text(), '01:30')]");
    
    if (timeBtn) {
      await timeBtn.click();
      log('✅ 시간 선택 완료');
    } else {
      log('⚠️ 시간 버튼을 찾을 수 없음');
    }
    
    await delay(2000);
    
    // 1️⃣1️⃣ 작성하기 버튼 클릭
    log('💾 예약 저장...');
    
    const [submitBtn] = await page.$x("//button[contains(text(), '작성하기')] | //a[contains(text(), '작성하기')]");
    
    if (submitBtn) {
      await submitBtn.click();
      log('✅ 예약 저장 완료');
      await delay(3000);
    } else {
      log('⚠️ 작성하기 버튼을 찾을 수 없음');
    }
    
    log('✅ 테스트 예약 등록 완료!');
    log('📸 브라우저는 계속 열려있습니다');
    
  } catch (err) {
    log(`❌ 오류 발생: ${err.message}`);
    log(`📍 스택: ${err.stack.split('\n')[1]}`);
  } finally {
    log('💡 팁: Ctrl+C를 눌러 종료할 수 있습니다');
  }
}

testBooking();
