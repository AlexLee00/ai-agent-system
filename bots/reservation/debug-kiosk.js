const puppeteer = require('puppeteer');
const { loadSecrets } = require('./lib/secrets');
const { getPickkoLaunchOptions, setupDialogHandler } = require('./lib/browser');
const { loginToPickko } = require('./lib/pickko');
const delay = ms => new Promise(r => setTimeout(r, ms));

const SECRETS = loadSecrets();
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

(async () => {
  const browser = await puppeteer.launch(getPickkoLaunchOptions());
  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  setupDialogHandler(page, console.log);

  await loginToPickko(page, SECRETS.pickko_id, SECRETS.pickko_pw, delay);
  await page.goto('https://pickkoadmin.com/study/index.html', { waitUntil: 'networkidle2' });
  await delay(2000);

  // 필터 설정
  const filterSet = await page.evaluate((todayStr) => {
    const r = {};
    const s = document.querySelector('input[name="sd_start_up"]');
    const e = document.querySelector('input[name="sd_start_dw"]');
    const a = document.querySelector('input[name="order_price_dw"]');
    if (s) { s.value = todayStr; s.dispatchEvent(new Event('change', { bubbles: true })); r.s = s.value; }
    if (e) { e.value = todayStr; e.dispatchEvent(new Event('change', { bubbles: true })); r.e = e.value; }
    if (a) { a.value = '1'; a.dispatchEvent(new Event('change', { bubbles: true })); r.a = a.value; }
    return r;
  }, today);
  console.log('필터 설정:', filterSet);

  // 검색
  try {
    await Promise.all([
      page.click('input[type="submit"][value="검색"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null)
    ]);
  } catch (e) {}
  await delay(2000);

  // study/view 링크가 있는 행만 (실제 예약 데이터 행)
  const dump = await page.evaluate(() => {
    const allTrs = Array.from(document.querySelectorAll('tbody tr'));
    const viewTrs = allTrs.filter(tr => tr.querySelector('a[href*="/study/view/"]'));
    const others = allTrs.filter(tr => !tr.querySelector('a[href*="/study/view/"]'));

    return {
      totalRows: allTrs.length,
      viewRows: viewTrs.length,
      // 예약 행 처음 5개 덤프
      viewDump: viewTrs.slice(0, 5).map(tr => {
        const tds = Array.from(tr.querySelectorAll('td'));
        return tds.map((td, i) => `[${i}] ${td.textContent.replace(/\s+/g, ' ').trim().slice(0, 40)}`);
      }),
      // 비예약 행 처음 3개 (디버깅용)
      otherSample: others.slice(0, 3).map(tr => tr.textContent.replace(/\s+/g, ' ').trim().slice(0, 60))
    };
  });

  console.log(`\n전체 tbody tr: ${dump.totalRows}행`);
  console.log(`예약 링크 있는 행: ${dump.viewRows}행`);
  console.log('\n=== 예약 데이터 행 (처음 5행) ===');
  dump.viewDump.forEach((row, i) => {
    console.log(`\n행 ${i}:`);
    row.forEach(cell => console.log('  ' + cell));
  });
  console.log('\n=== 비예약 행 샘플 ===');
  dump.otherSample.forEach((text, i) => console.log(`  [${i}] ${text}`));

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
