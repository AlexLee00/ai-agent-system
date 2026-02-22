const puppeteer = require('puppeteer');

async function checkNaver() {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  
  try {
    console.log('네이버 로그인 페이지 로드 중...');
    await page.goto('https://partner.booking.naver.com/', { waitUntil: 'networkidle2', timeout: 30000 });
    
    // 현재 URL 확인
    const currentUrl = page.url();
    console.log('현재 URL:', currentUrl);
    
    // iframe 체크
    const frames = page.frames();
    console.log(`\n총 ${frames.length}개 프레임 감지`);
    
    // 입력 필드 분석
    console.log('\n=== 모든 입력 필드 ===');
    const inputs = await page.evaluate(() => {
      const result = [];
      document.querySelectorAll('input').forEach((el, idx) => {
        result.push({
          idx,
          name: el.name,
          id: el.id,
          type: el.type,
          placeholder: el.placeholder,
          visible: el.offsetParent !== null
        });
      });
      return result;
    });
    
    console.log(JSON.stringify(inputs.slice(0, 10), null, 2));
    
    console.log('\n검사 완료. 브라우저는 열려있습니다. (Ctrl+C로 종료)');
    
  } catch (e) {
    console.error('오류:', e.message);
    await browser.close();
  }
}

checkNaver();
