/**
 * cancel-test-booking.js — 테스트 예약 취소 (1회 실행 후 삭제)
 * 대상: 이재룡 01035000586, 예약번호 928862
 */
const puppeteer = require('puppeteer');
const { loadSecrets } = require('./lib/secrets');
const { getPickkoLaunchOptions, setupDialogHandler } = require('./lib/browser');
const { loginToPickko } = require('./lib/pickko');
const delay = ms => new Promise(r => setTimeout(r, ms));

const SECRETS = loadSecrets();
const TARGET_URL = 'https://pickkoadmin.com/study/view/928862.html';

(async () => {
  console.log('🗑️  테스트 예약 취소: 이재룡 928862');
  const browser = await puppeteer.launch(getPickkoLaunchOptions());
  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  setupDialogHandler(page, console.log);

  await loginToPickko(page, SECRETS.pickko_id, SECRETS.pickko_pw, delay);
  console.log('✅ 픽코 로그인 완료');

  await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);

  // 페이지 내용 확인
  const pageInfo = await page.evaluate(() => {
    const body = document.body.innerText;
    // 예약 정보 확인
    const hasTarget = body.includes('이재룡') || body.includes('928862') || body.includes('01035000586');
    // 취소 버튼 찾기
    const btns = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a'))
      .filter(el => {
        const t = (el.textContent || el.value || '').trim();
        return t.includes('취소') || t.includes('삭제') || t.includes('cancel');
      })
      .map(el => ({
        tag: el.tagName,
        text: (el.textContent || el.value || '').trim().slice(0, 30),
        id: el.id,
        className: el.className.slice(0, 40)
      }));
    return { hasTarget, btns, url: window.location.href };
  });

  console.log('페이지 확인:', pageInfo.url);
  console.log('예약 정보 존재:', pageInfo.hasTarget);
  console.log('취소 관련 버튼:', JSON.stringify(pageInfo.btns, null, 2));

  if (!pageInfo.hasTarget) {
    console.log('⚠️  예약 정보를 찾을 수 없음. URL 확인 필요.');
    await browser.close();
    process.exit(1);
  }

  // 취소 버튼 클릭 시도
  if (pageInfo.btns.length === 0) {
    console.log('⚠️  취소 버튼을 찾을 수 없음. 스크린샷 저장...');
    await page.screenshot({ path: '/tmp/pickko-cancel-debug.png', fullPage: true });
    console.log('   스크린샷: /tmp/pickko-cancel-debug.png');
    await browser.close();
    process.exit(1);
  }

  // 첫 번째 취소 버튼 클릭
  const cancelBtn = pageInfo.btns[0];
  console.log(`\n🖱️  클릭: ${cancelBtn.tag} "${cancelBtn.text}"`);

  try {
    if (cancelBtn.tag === 'A') {
      // 링크 클릭
      await page.evaluate((text) => {
        const a = Array.from(document.querySelectorAll('a')).find(el => el.textContent.trim().includes(text));
        if (a) a.click();
      }, cancelBtn.text);
    } else if (cancelBtn.id) {
      await page.click(`#${cancelBtn.id}`);
    } else {
      await page.evaluate((text) => {
        const el = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'))
          .find(el => (el.textContent || el.value || '').trim().includes(text));
        if (el) el.click();
      }, cancelBtn.text);
    }

    await delay(3000);

    // 취소 확인 다이얼로그 처리 (setupDialogHandler가 이미 처리)
    const result = await page.evaluate(() => document.body.innerText.slice(0, 200));
    console.log('결과:', result);
    console.log('✅ 취소 처리 완료');
  } catch (e) {
    console.error('❌ 취소 실패:', e.message);
    await page.screenshot({ path: '/tmp/pickko-cancel-error.png', fullPage: true });
    console.log('   스크린샷: /tmp/pickko-cancel-error.png');
  }

  await browser.close();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
