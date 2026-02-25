/**
 * 이재룡 테스트 예약 추가 — 키오스크 시뮬레이션 (현금 5,000원)
 * 스터디룸A1 / 2026-02-25 / 20:00~21:00
 */
const puppeteer = require('puppeteer');
const { getPickkoLaunchOptions, setupDialogHandler } = require('./lib/browser');
const { loginToPickko } = require('./lib/pickko');
const { loadSecrets } = require('./lib/secrets');
const { delay, log } = require('./lib/utils');

const SECRETS = loadSecrets();

(async () => {
  const browser = await puppeteer.launch({ ...getPickkoLaunchOptions(), headless: false });
  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  page.setDefaultTimeout(30000);
  setupDialogHandler(page, log);

  await loginToPickko(page, SECRETS.pickko_id, SECRETS.pickko_pw, delay);
  log('✅ 로그인 완료');

  // 신규 예약 작성 페이지
  await page.goto('https://pickkoadmin.com/study/write.html', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);
  log('URL: ' + page.url());

  // 폼 필드 확인
  const fields = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input[name], select[name], textarea[name]')).map(el => ({
      tag: el.tagName, name: el.name, type: el.type || '', value: el.value || ''
    }));
  });
  log('폼 필드: ' + JSON.stringify(fields));

  await page.screenshot({ path: '/tmp/new-booking-form.png', fullPage: false });
  log('스크린샷: /tmp/new-booking-form.png');

  await browser.close();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
