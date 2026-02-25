/**
 * SmartPlace 예약 관리 UI 탐색
 * - 예약불가 설정 URL 찾기
 */
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { delay } = require('./lib/utils');

const PLACE_ID = '3990161';
const BIZE_ID = '596871';

(async () => {
  const wsFile = path.join(process.env.HOME, '.openclaw/workspace/naver-monitor-ws.txt');
  const ws = fs.readFileSync(wsFile, 'utf8').trim();
  const browser = await puppeteer.connect({ browserWSEndpoint: ws });

  const pg = await browser.newPage();
  await pg.setViewport({ width: 1920, height: 1080 });

  // partner.booking.naver.com의 설정 페이지 탐색
  const urls = [
    `https://partner.booking.naver.com/bizes/${BIZE_ID}/booking-setting`,
    `https://partner.booking.naver.com/bizes/${BIZE_ID}/booking-unavailable`,
    `https://partner.booking.naver.com/bizes/${BIZE_ID}/products`,
    `https://new.smartplace.naver.com/bizes/place/${PLACE_ID}/booking`,
    `https://new.smartplace.naver.com/bizes/place/${PLACE_ID}/booking-management`,
  ];

  for (const url of urls) {
    try {
      await pg.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 });
      await delay(1500);
      const title = await pg.title();
      const currentUrl = pg.url();
      const pageText = await pg.evaluate(() => (document.body?.innerText || '').slice(0, 300));
      console.log(`\nURL: ${url}`);
      console.log(`Redirected to: ${currentUrl.slice(0, 100)}`);
      console.log(`Title: ${title}`);
      console.log(`Content: ${pageText.replace(/\n/g, ' ').slice(0, 200)}`);
    } catch (e) {
      console.log(`\nURL: ${url} → ERROR: ${e.message.slice(0, 80)}`);
    }
  }

  // partner.booking.naver.com에서 메뉴 링크 탐색
  await pg.goto(`https://partner.booking.naver.com/bizes/${BIZE_ID}/booking-calendar-view`, {
    waitUntil: 'domcontentloaded', timeout: 15000
  });
  await pg.waitForNetworkIdle({ idleTime: 800, timeout: 8000 }).catch(() => {});
  await delay(1500);
  await pg.screenshot({ path: '/tmp/partner-menu.png', fullPage: false });

  const menuLinks = await pg.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a, [class*="menu"], [class*="nav"], [class*="tab"]'));
    return links
      .filter(l => l.offsetParent !== null)
      .map(l => ({
        tag: l.tagName,
        text: (l.textContent || l.title || '').trim().slice(0, 40),
        href: l.href || l.getAttribute('href') || '',
      }))
      .filter(l => l.text.length > 0)
      .slice(0, 30);
  });
  console.log('\n파트너 booking 메뉴:', JSON.stringify(menuLinks, null, 2));

  await pg.close();
  browser.disconnect();
})().catch(e => console.error(e.message));
