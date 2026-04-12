/// <reference lib="dom" />
'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { getNaverLaunchOptions, isHeadedMode } = require('../lib/browser');
const WORKSPACE = path.join(process.env.HOME, '.openclaw', 'workspace');

async function inspect() {
  const browser = await puppeteer.launch(getNaverLaunchOptions());
  const page = await browser.newPage();

  try {
    console.log('네이버 홈 접속...');
    await page.goto('https://new.smartplace.naver.com/bizes/place/3990161', { waitUntil: 'networkidle2', timeout: 30000 });

    await new Promise(r => setTimeout(r, 3000));

    console.log('\n=== 홈 페이지 HTML 검사 ===');
    const html = await page.content();

    const stats = await page.evaluate(() => {
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null
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

    fs.writeFileSync(path.join(WORKSPACE, 'naver-home.html'), html);
    console.log('\n✅ HTML이 naver-home.html에 저장됨');

    console.log(`\n현재 모드: ${isHeadedMode('naver') ? 'headed' : 'headless'}`);
    console.log('브라우저를 보며 조사하려면 PLAYWRIGHT_HEADLESS=false 로 재실행하세요.');
  } catch (e) {
    console.error('오류:', e.message);
  } finally {
    await browser.close();
  }
}

inspect();
