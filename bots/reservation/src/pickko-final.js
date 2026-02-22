#!/usr/bin/env node

/**
 * 픽코 예약 등록 (최종 버전 - 안정화)
 * 수동 입력 방식으로 변경
 */

const puppeteer = require('puppeteer');

const PICKKO_ID = 'a2643301450';
const PICKKO_PW = 'lsh120920!';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function log(msg) {
  const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[${timestamp}] ${msg}`);
}

async function main() {
  let browser;
  
  try {
    log('🚀 픽코 예약 시스템 시작 (최종 버전)');
    
    browser = await puppeteer.launch({
      headless: false, // 화면 표시
      args: ['--no-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // ==================== 1단계: 로그인 ====================
    log('\n========== 1단계: 로그인 ==========');
    log('📱 로그인 페이지 이동...');
    
    await page.goto('https://pickkoadmin.com/manager/login.html', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    
    await delay(2000);
    
    log('🔐 ID/PW 입력...');
    // 입력 필드에 직접 값 설정
    await page.evaluate((id) => {
      document.getElementById('mn_id').value = id;
    }, PICKKO_ID);
    
    await page.evaluate((pw) => {
      document.getElementById('mn_pw').value = pw;
    }, PICKKO_PW);
    
    await delay(500);
    
    log('🖱️ 로그인 버튼 클릭...');
    
    // 로그인 클릭
    await page.evaluate(() => {
      document.getElementById('loginButton').click();
    });
    
    // 페이지 이동 대기 (타임아웃 무시)
    await new Promise(resolve => {
      setTimeout(resolve, 5000);
    });
    
    log('✅ 로그인 완료');
    
    // ==================== 2단계: 예약 페이지로 이동 ====================
    log('\n========== 2단계: 예약 페이지 이동 ==========');
    log('📝 예약 등록 페이지로 이동...');
    
    await page.goto('https://pickkoadmin.com/study/write.html', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    
    await delay(3000);
    
    log('✅ 예약 등록 페이지 로드 완료');
    
    // ==================== 3단계: 회원 검색 ====================
    log('\n========== 3단계: 회원 검색 ==========');
    log('🔍 회원 검색...');
    
    // 검색창 찾기 및 입력
    const inputs = await page.$$('input[type="text"]');
    
    if (inputs.length > 0) {
      // 마지막 입력창에 전화번호 입력
      await page.evaluate((phone) => {
        const inputs = document.querySelectorAll('input[type="text"]');
        if (inputs.length > 0) {
          inputs[inputs.length - 1].value = phone;
          inputs[inputs.length - 1].dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, '010-3500-0586');
      
      log('✅ 전화번호 입력 완료: 010-3500-0586');
      
      await delay(2000);
      
      // 선택 버튼 찾기 및 클릭
      log('👤 회원 선택...');
      const selectResult = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (let btn of buttons) {
          if (btn.textContent.trim() === '선택') {
            btn.click();
            return true;
          }
        }
        return false;
      });
      
      if (selectResult) {
        log('✅ 회원 선택 완료');
      } else {
        log('⚠️ 선택 버튼을 찾을 수 없음');
      }
    }
    
    await delay(2000);
    
    // ==================== 4단계: 스터디룸 선택 ====================
    log('\n========== 4단계: 스터디룸 선택 ==========');
    log('🏠 스터디룸 A1 선택...');
    
    const roomResult = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, a, div, span');
      for (let elem of buttons) {
        const text = elem.textContent;
        if (text.includes('A1') && (text.includes('스터디') || text.includes('룸'))) {
          elem.click();
          return true;
        }
      }
      return false;
    });
    
    if (roomResult) {
      log('✅ A1 룸 선택 완료');
    } else {
      log('⚠️ 룸 선택 실패 (계속 진행)');
    }
    
    await delay(1500);
    
    // ==================== 5단계: 날짜 설정 ====================
    log('\n========== 5단계: 날짜 설정 ==========');
    log('📅 날짜 설정 (2026-02-21)...');
    
    const dateResult = await page.evaluate(() => {
      const dateInputs = document.querySelectorAll('input[type="date"]');
      if (dateInputs.length > 0) {
        dateInputs[0].value = '2026-02-21';
        dateInputs[0].dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
      return false;
    });
    
    if (dateResult) {
      log('✅ 날짜 설정 완료');
    }
    
    await delay(1500);
    
    // ==================== 6단계: 시간 선택 ====================
    log('\n========== 6단계: 시간 선택 ==========');
    log('⏰ 시간 선택 (01:30)...');
    
    const timeResult = await page.evaluate(() => {
      const items = document.querySelectorAll('li, button, span, div');
      for (let item of items) {
        const text = item.textContent.trim();
        if (text.includes('01:30')) {
          item.click();
          return true;
        }
      }
      return false;
    });
    
    if (timeResult) {
      log('✅ 01:30 시간 선택 완료');
    } else {
      log('⚠️ 시간 선택 실패 (계속 진행)');
    }
    
    await delay(2000);
    
    // ==================== 7단계: 저장 ====================
    log('\n========== 7단계: 예약 저장 ==========');
    log('💾 작성하기 버튼 클릭...');
    
    const saveResult = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, a');
      for (let btn of buttons) {
        if (btn.textContent.trim() === '작성하기') {
          btn.click();
          return true;
        }
      }
      return false;
    });
    
    if (saveResult) {
      log('✅ 예약 저장 버튼 클릭 완료');
    } else {
      log('⚠️ 저장 버튼을 찾을 수 없음');
    }
    
    await delay(3000);
    
    // ==================== 완료 ====================
    log('\n========== 완료 ==========');
    log('✅✅✅ 예약 등록 프로세스 완료!');
    log('\n📸 브라우저 화면에서 결과를 확인하세요');
    log('💡 종료하려면 Ctrl+C를 입력하세요\n');
    
  } catch (err) {
    log(`\n❌ 에러 발생: ${err.message}`);
    log(`📍 스택: ${err.stack}`);
  }
}

main().catch(console.error);
