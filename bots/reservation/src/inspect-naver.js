const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const WORKSPACE = path.join(process.env.HOME, '.openclaw', 'workspace');

async function inspect() {
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  
  try {
    console.log('네이버 홈 접속...');
    await page.goto('https://new.smartplace.naver.com/bizes/place/3990161', { waitUntil: 'networkidle2', timeout: 30000 });
    
    await new Promise(r => setTimeout(r, 3000));
    
    console.log('\n=== 홈 페이지 HTML 검사 ===');
    const html = await page.content();
    
    // 핵심 정보 추출
    const stats = await page.evaluate(() => {
      const result = {};
      
      // 모든 텍스트 노드에서 숫자 찾기
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );
      
      let node;
      const texts = [];
      while (node = walker.nextNode()) {
        texts.push(node.textContent.trim());
      }
      
      return texts.filter(t => t.length > 0 && t.length < 100);
    });
    
    console.log('페이지 주요 텍스트:');
    console.log(stats.slice(0, 50).join('\n'));
    
    // 테이블/리스트 요소 찾기
    console.log('\n=== 테이블/리스트 요소 ===');
    const elements = await page.evaluate(() => {
      return {
        tables: document.querySelectorAll('table').length,
        divs_with_class: Array.from(document.querySelectorAll('div[class*="list"], div[class*="table"]')).length,
        rows: document.querySelectorAll('tr').length,
        cells: document.querySelectorAll('td, th').length
      };
    });
    
    console.log(JSON.stringify(elements, null, 2));
    
    // HTML 저장
    fs.writeFileSync(path.join(WORKSPACE, 'naver-home.html'), html);
    console.log('\n✅ HTML이 naver-home.html에 저장됨');
    
    console.log('\n브라우저는 열려있습니다. 예약 리스트를 클릭하거나 조사해보세요.');
    console.log('조사 완료 후 터미널에서 Ctrl+C를 누르세요.');
    
  } catch (e) {
    console.error('오류:', e.message);
    await browser.close();
  }
}

inspect();
