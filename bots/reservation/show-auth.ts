const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

(async () => {
  const ws = fs.readFileSync(
    path.join(process.env.HOME, '.openclaw/workspace/naver-monitor-ws.txt'),
    'utf8',
  ).trim();
  const browser = await puppeteer.connect({ browserWSEndpoint: ws });
  const pages = await browser.pages();
  console.log(`열린 탭 수: ${pages.length}`);
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    const url = page.url();
    const title = await page.title().catch(() => '?');
    console.log(`  [${i}] ${title} | ${url.slice(0, 100)}`);
    await page.screenshot({ path: `/tmp/naver-tab-${i}.png`, fullPage: false }).catch(() => {});
  }
  browser.disconnect();
})().catch((error) => console.error(error.message));
