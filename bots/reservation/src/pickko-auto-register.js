#!/usr/bin/env node

/**
 * 픽코 키오스크 자동 예약 등록 스크립트
 * 네이버에서 감지된 예약을 픽코에 자동으로 등록
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// 설정
const PICKKO_ID = 'a2643301450';
const PICKKO_PW = 'lsh120920!';
const PICKKO_URL = 'https://pickkoadmin.com/study/index.html';
const NAVER_URL = 'https://partner.booking.naver.com/bizes/596871/booking-calendar-view';

// 대기 함수
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 로그 함수
function log(msg) {
  const timestamp = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[${timestamp}] ${msg}`);
}

/**
 * 네이버에서 오늘의 예약 정보 추출
 */
async function getNaverBookings(page) {
  try {
    log('📥 네이버에서 예약 정보 추출 중...');
    
    const bookings = await page.evaluate(() => {
      const data = [];
      
      // 예약 테이블의 각 행 파싱
      const rows = document.querySelectorAll('table tbody tr');
      
      rows.forEach((row) => {
        try {
          const cells = row.querySelectorAll('td');
          
          if (cells.length >= 5) {
            const booking = {
              name: cells[1]?.textContent?.trim() || '',
              phone: cells[2]?.textContent?.trim() || '',
              time: cells[3]?.textContent?.trim() || '',
              room: cells[4]?.textContent?.trim() || '',
              date: new Date().toISOString().split('T')[0] // 오늘 날짜
            };
            
            // 유효한 데이터만 추가
            if (booking.name && booking.phone && booking.time) {
              data.push(booking);
            }
          }
        } catch (err) {
          // 파싱 오류 무시
        }
      });
      
      return data;
    });
    
    log(`✅ ${bookings.length}건의 예약 정보 추출 완료`);
    return bookings;
  } catch (err) {
    log(`❌ 네이버 데이터 추출 실패: ${err.message}`);
    return [];
  }
}

/**
 * 픽코 로그인
 */
async function pickkoLogin(page) {
  try {
    log('🔐 픽코 로그인 시작...');
    
    await page.goto(PICKKO_URL, { waitUntil: 'networkidle2', timeout: 10000 });
    
    // 로그인 상태 확인
    const isLoggedIn = await page.evaluate(() => {
      return document.querySelector('[class*="분당서현"]') !== null ||
             document.querySelector('a[href*="logout"]') !== null;
    });
    
    if (isLoggedIn) {
      log('✅ 이미 로그인되어 있습니다');
      return true;
    }
    
    // 로그인 페이지 확인
    const loginPageUrl = await page.url();
    log(`현재 URL: ${loginPageUrl}`);
    
    if (loginPageUrl.includes('login')) {
      log('🔑 로그인 폼 입력 중...');
      
      // ID 입력 (#mn_id)
      await page.type('#mn_id', PICKKO_ID, { delay: 50 });
      
      // PW 입력 (#mn_pw)
      await page.type('#mn_pw', PICKKO_PW, { delay: 50 });
      
      // 로그인 버튼 클릭 (#loginButton)
      await Promise.all([
        page.click('#loginButton'),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 })
      ]);
      
      log('✅ 픽코 로그인 완료');
    }
    
    return true;
  } catch (err) {
    log(`❌ 픽코 로그인 실패: ${err.message}`);
    return false;
  }
}

/**
 * 픽코에서 회원 검색 및 선택
 */
async function selectMember(page, phoneNumber) {
  try {
    log(`🔍 회원 검색 중 (전화: ${phoneNumber})...`);
    
    // 우측 회원 검색창 찾기
    const searchInput = await page.$('input[placeholder*="이름"]');
    
    if (!searchInput) {
      log('⚠️ 검색 입력창을 찾을 수 없음');
      return false;
    }
    
    // 검색창에 전화번호 입력
    await searchInput.type(phoneNumber, { delay: 50 });
    
    // 검색 실행 대기
    await delay(1000);
    
    // 검색 결과에서 첫 번째 회원 클릭
    const memberItem = await page.$('[class*="member"] button, [class*="member"] a');
    
    if (memberItem) {
      await memberItem.click();
      log(`✅ 회원 선택 완료: ${phoneNumber}`);
      return true;
    } else {
      log(`⚠️ 회원을 찾을 수 없음: ${phoneNumber}`);
      return false;
    }
  } catch (err) {
    log(`❌ 회원 검색/선택 실패: ${err.message}`);
    return false;
  }
}

/**
 * 시간 문자열 파싱 (예: "08:30-11:30" → { start: "08:30", end: "11:30" })
 */
function parseTime(timeStr) {
  // 예약 시간 형식: "2.21(토) 오전 8:30-11:30"
  const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})/);
  
  if (!timeMatch) {
    return null;
  }
  
  return {
    start: `${timeMatch[1].padStart(2, '0')}:${timeMatch[2]}`,
    end: `${timeMatch[3].padStart(2, '0')}:${timeMatch[4]}`,
    duration: calculateDuration(timeMatch[1], timeMatch[2], timeMatch[3], timeMatch[4])
  };
}

/**
 * 예약 시간 계산 (분 단위)
 */
function calculateDuration(startH, startM, endH, endM) {
  const start = parseInt(startH) * 60 + parseInt(startM);
  const end = parseInt(endH) * 60 + parseInt(endM);
  return end - start;
}

/**
 * 룸 이름 정규화 (예: "A1룸" → "A1")
 */
function normalizeRoom(roomStr) {
  const match = roomStr.match(/([AB]\d?)/);
  return match ? match[1] : roomStr;
}

/**
 * 픽코에 예약 등록
 */
async function registerBooking(page, booking) {
  try {
    log(`\n📝 예약 등록 시작: ${booking.name} (${booking.phone})`);
    
    // 1️⃣ 회원 선택
    log('1️⃣ 회원 선택...');
    const memberSelected = await selectMember(page, booking.phone);
    
    if (!memberSelected) {
      log(`⚠️ 회원 선택 실패 - 예약 스킵`);
      return false;
    }
    
    await delay(1000);
    
    // 2️⃣ 스터디룸 선택
    log('2️⃣ 스터디룸 선택...');
    const roomNormalized = normalizeRoom(booking.room);
    const roomSelector = `[class*="room"]:contains("${roomNormalized}")`;
    
    // 더 정확한 선택자 사용
    const roomButtons = await page.$$('[class*="room"], button');
    let roomSelected = false;
    
    for (const btn of roomButtons) {
      const text = await page.evaluate(el => el.textContent, btn);
      if (text.includes(roomNormalized)) {
        await btn.click();
        log(`✅ 룸 선택 완료: ${roomNormalized}`);
        roomSelected = true;
        break;
      }
    }
    
    if (!roomSelected) {
      log(`⚠️ 룸 선택 실패: ${roomNormalized}`);
      // 계속 진행
    }
    
    await delay(1000);
    
    // 3️⃣ 이용 날짜 설정
    log('3️⃣ 이용 날짜 설정...');
    const dateInputs = await page.$$('input[type="date"], input[placeholder*="2026"]');
    if (dateInputs.length > 0) {
      await dateInputs[0].type(booking.date, { delay: 50 });
      log(`✅ 날짜 설정 완료: ${booking.date}`);
    }
    
    await delay(1000);
    
    // 4️⃣ 시간 선택
    log('4️⃣ 시간 선택...');
    const parsedTime = parseTime(booking.time);
    
    if (parsedTime) {
      // 시간 선택 버튼들 찾기
      const timeButtons = await page.$$('button, [role="button"]');
      let timeSelected = false;
      
      for (const btn of timeButtons) {
        const text = await page.evaluate(el => el.textContent, btn);
        if (text.includes(parsedTime.start.split(':')[0])) {
          await btn.click();
          log(`✅ 시간 선택 완료: ${parsedTime.start}`);
          timeSelected = true;
          break;
        }
      }
      
      if (!timeSelected) {
        log(`⚠️ 시간 선택 실패: ${parsedTime.start}`);
      }
    }
    
    await delay(1000);
    
    // 5️⃣ 작성하기 버튼 클릭
    log('5️⃣ 예약 등록 버튼 클릭...');
    const submitBtn = await page.$('button:contains("작성하기"), button[class*="submit"]');
    
    if (submitBtn) {
      await submitBtn.click();
      log(`✅ 예약 등록 완료: ${booking.name}`);
      
      // 완료 메시지 대기
      await delay(2000);
      return true;
    } else {
      log(`⚠️ 작성하기 버튼을 찾을 수 없음`);
      return false;
    }
    
  } catch (err) {
    log(`❌ 예약 등록 실패: ${err.message}`);
    return false;
  }
}

/**
 * 메인 자동 등록 함수
 */
async function autoRegisterBookings() {
  let naverPage, pickkoPage;
  let browser;
  
  try {
    log('🚀 픽코 자동 등록 시작');
    
    // Puppeteer 실행
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    // 네이버 페이지 열기
    log('📱 네이버 페이지 열기...');
    naverPage = await browser.newPage();
    await naverPage.setViewport({ width: 1920, height: 1080 });
    await naverPage.goto(NAVER_URL, { waitUntil: 'networkidle2', timeout: 15000 });
    
    // 픽코 페이지 열기
    log('📱 픽코 페이지 열기...');
    pickkoPage = await browser.newPage();
    await pickkoPage.setViewport({ width: 1920, height: 1080 });
    
    // 픽코 로그인
    const loggedIn = await pickkoLogin(pickkoPage);
    if (!loggedIn) {
      log('❌ 픽코 로그인 실패로 종료');
      return;
    }
    
    // 네이버에서 예약 정보 추출
    const bookings = await getNaverBookings(naverPage);
    
    if (bookings.length === 0) {
      log('ℹ️ 등록할 예약이 없습니다');
      return;
    }
    
    // 각 예약을 픽코에 등록
    let successCount = 0;
    for (const booking of bookings) {
      try {
        // 픽코 예약 등록 페이지로 이동
        await pickkoPage.goto(PICKKO_URL, { waitUntil: 'networkidle2', timeout: 10000 });
        
        await delay(1000);
        
        // 예약 등록
        const result = await registerBooking(pickkoPage, booking);
        
        if (result) {
          successCount++;
          log(`✅ (${successCount}/${bookings.length}) 등록 완료`);
        }
        
        // 다음 예약 전 대기
        await delay(2000);
        
      } catch (err) {
        log(`❌ 예약 처리 중 오류: ${err.message}`);
      }
    }
    
    log(`\n📊 최종 결과: ${successCount}/${bookings.length}건 등록`);
    
  } catch (err) {
    log(`❌ 치명적 오류: ${err.message}`);
  } finally {
    if (browser) {
      await browser.close();
      log('🔌 브라우저 종료');
    }
  }
}

/**
 * 정기 자동 등록 (1시간마다)
 */
async function startAutoRegistration() {
  log('⏰ 픽코 자동 등록 스케줄러 시작 (1시간 주기)');
  
  // 초기 실행
  await autoRegisterBookings();
  
  // 1시간마다 반복
  setInterval(async () => {
    log('\n------- 정기 자동 등록 실행 -------');
    await autoRegisterBookings();
  }, 60 * 60 * 1000);
}

// 실행
if (process.argv.includes('--schedule')) {
  // 스케줄 모드: 1시간마다 자동 실행
  startAutoRegistration();
} else {
  // 단회 모드: 한 번만 실행
  autoRegisterBookings().catch(err => {
    log(`❌ 예상치 못한 오류: ${err.message}`);
    process.exit(1);
  });
}
