#!/usr/bin/env node

/**
 * 픽코 예약 등록 (단순 버전)
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

async function autoRegister() {
  let browser;
  
  try {
    log('🚀 픽코 예약 자동 등록 시작');
    
    // 브라우저 실행
    browser = await puppeteer.launch({
      headless: false,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    // 단계 1: 픽코 로그인 페이지 접속
    log('\n[1/7] 픽코 접속');
    await page.goto('https://pickkoadmin.com/manager/login.html', { waitUntil: 'domcontentloaded' });
    await delay(2000);
    
    // 단계 2: 로그인
    log('[2/7] 로그인');
    await page.type('#mn_id', PICKKO_ID);
    await page.type('#mn_pw', PICKKO_PW);
    await page.click('#loginButton');
    await delay(5000);
    
    // 단계 3: 스터디룸 페이지 접속
    log('[3/7] 스터디룸 페이지로 이동');
    await page.goto('https://pickkoadmin.com/study/index.html', { waitUntil: 'domcontentloaded' });
    await delay(3000);
    
    // 단계 4: 페이지 상태 출력
    log('[4/7] 현재 페이지 분석');
    const pageContent = await page.content();
    
    // 예약등록이 있는지 확인
    if (pageContent.includes('예약등록')) {
      log('  ✅ "예약등록" 텍스트 발견');
    }
    
    // 회원 검색창 찾기
    const inputs = await page.$$('input');
    log(`  📊 입력창 ${inputs.length}개 발견`);
    
    // 단계 5: 전화번호 입력 (첫 번째 텍스트 입력창)
    log('[5/7] 회원 검색: 010-3500-0586');
    if (inputs.length > 0) {
      await inputs[0].click();
      await inputs[0].type('010-3500-0586');
      await delay(1500);
      log('  ✅ 전화번호 입력 완료');
    }
    
    // 단계 6: 회원/스터디룸/시간 정보는 수동으로 선택하도록 안내
    log('[6/7] 수동 선택 준비');
    log('');
    log('⚠️ 다음 항목들을 화면에서 수동으로 선택해주세요:');
    log('   1. 우측 회원 목록에서 "010-3500-0586" → "선택" 버튼 클릭');
    log('   2. 스터디룸: "A1" 선택');
    log('   3. 날짜: "2026-02-21" 선택');
    log('   4. 시간: "01:30~02:00" 선택');
    log('   5. "작성하기" 버튼 클릭');
    log('');
    log('💡 30초 후 자동으로 계속 진행됩니다...');
    log('');
    
    // 사용자가 수동으로 선택할 수 있도록 30초 대기
    for (let i = 30; i > 0; i--) {
      await delay(1000);
      process.stdout.write(`\r⏳ 대기 중: ${i}초`);
    }
    console.log('\n');
    
    // 단계 7: 완료 확인
    log('[7/7] 예약 등록 완료 확인');
    log('✅ 예약이 등록되었는지 확인해주세요!');
    log('');
    log('📸 브라우저는 계속 열려있습니다');
    log('💡 Ctrl+C를 눌러 종료할 수 있습니다');
    
  } catch (err) {
    log(`❌ 오류: ${err.message}`);
  } finally {
    // 브라우저 유지
  }
}

autoRegister();
