#!/usr/bin/env node

/**
 * 네이버 예약 파싱 테스트 - 전체 10건 출력
 */

const puppeteer = require('puppeteer');

const NAVER_ID = 'blockchainmaster';
const NAVER_PW = 'LEEjr03311030!';

async function testNaverParse() {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();

  try {
    console.log('🚀 테스트 시작...');
    
    // 로그인
    await page.goto('https://partner.booking.naver.com', { waitUntil: 'networkidle0' });
    
    // 로그인 ID/PW 입력
    await page.type('input[name="id"]', NAVER_ID, { delay: 50 });
    await page.type('input[name="pw"]', NAVER_PW, { delay: 50 });
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'networkidle0' });
    
    console.log('✅ 로그인 완료');

    // 예약현황 페이지 이동
    await page.goto('https://partner.booking.naver.com/bizes/596871/booking-list-view?bookingStatusCodes=RC03&dateDropdownType=TODAY&dateFilter=REGDATE&endDateTime=2026-02-22&startDateTime=2026-02-22', { waitUntil: 'networkidle0' });
    
    // 팝업 닫기
    try {
      await page.click('button[class*="Button_close"]');
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {}

    // 전체 테이블 데이터 추출
    const bookings = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('table tr')).slice(1); // 헤더 제외
      
      return rows.map(row => {
        const cells = Array.from(row.querySelectorAll('td'));
        if (cells.length < 4) return null;
        
        const statusEl = cells[0]?.textContent?.trim();
        const nameEl = cells[1]?.textContent?.trim();
        const phoneEl = cells[2]?.textContent?.trim();
        const bookingIdEl = cells[3]?.textContent?.trim();
        const dateTimeEl = cells[4]?.textContent?.trim();
        const roomEl = cells[5]?.textContent?.trim();
        
        return {
          status: statusEl,
          name: nameEl,
          phone: phoneEl,
          bookingId: bookingIdEl,
          dateTime: dateTimeEl,
          room: roomEl
        };
      }).filter(x => x && x.phone);
    });

    console.log('\n📋 전체 예약 데이터 (10건):');
    console.log(JSON.stringify(bookings, null, 2));
    
    console.log(`\n✅ 총 ${bookings.length}건 추출됨`);
    
  } catch (err) {
    console.error('❌ 에러:', err.message);
  } finally {
    await browser.close();
  }
}

testNaverParse();
