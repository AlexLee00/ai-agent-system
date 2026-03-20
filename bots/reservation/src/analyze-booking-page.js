const puppeteer = require('puppeteer');
const fs = require('fs');
const { getNaverLaunchOptions, isHeadedMode } = require('../lib/browser');

async function analyze() {
  const browser = await puppeteer.launch({
    ...getNaverLaunchOptions({
      userDataDir: './naver-profile',
    }),
    args: [
      ...getNaverLaunchOptions({ userDataDir: './naver-profile' }).args,
      ...(isHeadedMode('naver') ? ['--start-maximized', '--kiosk'] : [])
    ]
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 2560, height: 1600 });
  
  try {
    console.log('✨ 예약 리스트 페이지를 MacBook 전체 화면에 띄우는 중...');
    await page.goto('https://partner.booking.naver.com/bizes/596871/booking-list-view', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    await new Promise(r => setTimeout(r, 3000));
    
    console.log('✅ 페이지 로드 완료!');
    console.log('현재 URL:', page.url());
    
    // HTML 저장
    const html = await page.content();
    fs.writeFileSync('./booking-list-page.html', html);
    
    // 페이지 분석
    const analysis = await page.evaluate(() => {
      return {
        title: document.title,
        rows: document.querySelectorAll('tr').length,
        tables: document.querySelectorAll('table').length,
        all_text: document.body.innerText.substring(0, 2000)
      };
    });
    
    console.log('\n=== 📋 페이지 분석 ===');
    console.log('제목:', analysis.title);
    console.log('테이블 행 수:', analysis.rows);
    console.log('테이블 개수:', analysis.tables);
    
    console.log('\n=== 📄 페이지 텍스트 샘플 ===');
    console.log(analysis.all_text);
    
    console.log('\n\n✅ HTML이 booking-list-page.html에 저장됨');
    console.log(`\n현재 모드: ${isHeadedMode('naver') ? 'headed' : 'headless'}`);
    console.log('브라우저를 직접 보며 조사하려면 PLAYWRIGHT_HEADLESS=false 로 재실행하세요.');
    
    // 무한 대기 (사용자가 Ctrl+C를 누를 때까지)
    await new Promise(() => {});
    
  } catch (e) {
    console.error('❌ 오류:', e.message);
    await browser.close();
  }
}

analyze();
