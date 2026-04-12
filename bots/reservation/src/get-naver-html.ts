/// <reference lib="dom" />
const puppeteer = require('puppeteer');
const fs = require('fs');
const { getNaverLaunchOptions, isHeadedMode } = require('../lib/browser');

async function getHTML() {
  const baseLaunchOptions = getNaverLaunchOptions() as { args?: string[] } & Record<string, unknown>;
  const browser = await puppeteer.launch({
    ...baseLaunchOptions,
    args: [
      ...(baseLaunchOptions.args || []),
      ...(isHeadedMode('naver') ? ['--start-maximized', '--kiosk'] : [])
    ]
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
        const htmlEl = el as HTMLElement;
        const buttonEl = el as HTMLButtonElement;
        if (idx < 20) {  // 처음 20개만
          result.push({
            idx,
            text: htmlEl.innerText || htmlEl.textContent,
            className: htmlEl.className,
            type: buttonEl.type || '',
            outerHTML: htmlEl.outerHTML.substring(0, 150)
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
    
    console.log(`\n현재 모드: ${isHeadedMode('naver') ? 'headed' : 'headless'}`);
    console.log('브라우저를 직접 보려면 PLAYWRIGHT_HEADLESS=false 로 재실행하세요.');
    
    // 무한 대기
    await new Promise<void>(() => {});
    
  } catch (e) {
    console.error('오류:', e.message);
  } finally {
    await browser.close();
  }
}

getHTML();
