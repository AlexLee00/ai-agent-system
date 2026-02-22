const puppeteer = require('puppeteer');
const fs = require('fs');

async function getHTML() {
  const browser = await puppeteer.launch({
    headless: false,
    args: ['--start-maximized', '--kiosk']
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 2560, height: 1600 });
  
  try {
    console.log('네이버 로그인 페이지 접속...');
    await page.goto('https://partner.booking.naver.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    await new Promise(r => setTimeout(r, 3000));
    
    const html = await page.content();
    
    // 입력 필드 찾기
    const inputs = await page.evaluate(() => {
      const result = [];
      document.querySelectorAll('input').forEach((el, idx) => {
        result.push({
          idx,
          name: el.name,
          id: el.id,
          type: el.type,
          placeholder: el.placeholder,
          className: el.className,
          ariaLabel: el.getAttribute('aria-label'),
          dataTestid: el.getAttribute('data-testid'),
          outerHTML: el.outerHTML.substring(0, 200)
        });
      });
      return result;
    });
    
    // 버튼 찾기
    const buttons = await page.evaluate(() => {
      const result = [];
      document.querySelectorAll('button, a[role="button"]').forEach((el, idx) => {
        if (idx < 20) {  // 처음 20개만
          result.push({
            idx,
            text: el.innerText || el.textContent,
            className: el.className,
            type: el.type,
            outerHTML: el.outerHTML.substring(0, 150)
          });
        }
      });
      return result;
    });
    
    console.log('\n=== 📋 입력 필드 분석 ===');
    console.log(JSON.stringify(inputs, null, 2));
    
    console.log('\n=== 🔘 버튼 분석 ===');
    console.log(JSON.stringify(buttons, null, 2));
    
    // HTML 저장
    fs.writeFileSync('./naver-login-page.html', html);
    console.log('\n✅ HTML이 naver-login-page.html에 저장됨');
    
    console.log('\n브라우저는 열려있습니다. 확인 후 Ctrl+C를 누르세요.');
    
    // 무한 대기
    await new Promise(() => {});
    
  } catch (e) {
    console.error('오류:', e.message);
    await browser.close();
  }
}

getHTML();
