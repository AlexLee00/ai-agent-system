/**
 * finalize-test-payment.js — 결제대기 → 결제완료 처리
 * 주문 21160912, 928862 (이재룡 7,000원)
 */
const puppeteer = require('puppeteer');
const { loadSecrets } = require('./lib/secrets');
const { getPickkoLaunchOptions, setupDialogHandler } = require('./lib/browser');
const { loginToPickko } = require('./lib/pickko');
const delay = ms => new Promise(r => setTimeout(r, ms));

const SECRETS = loadSecrets();
const ORDER_URL = 'https://pickkoadmin.com/study/view/928862.html#/order/view/21160912';

(async () => {
  console.log('💳 결제대기 → 결제완료 처리');
  const browser = await puppeteer.launch(getPickkoLaunchOptions());
  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  setupDialogHandler(page, console.log);

  await loginToPickko(page, SECRETS.pickko_id, SECRETS.pickko_pw, delay);
  console.log('✅ 픽코 로그인 완료');

  // 주문 뷰 직접 이동
  await page.goto(ORDER_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);

  // 현재 상태 확인
  const state1 = await page.evaluate(() => {
    const body = document.body.innerText;
    const modal = document.querySelector('[class*="modal"], [id*="modal"], [class*="popup"]');
    // 결제하기 버튼 찾기
    const btns = Array.from(document.querySelectorAll('button, a, input[type="button"]'))
      .filter(el => (el.textContent || el.value || '').trim().includes('결제하기'))
      .map(el => ({
        tag: el.tagName,
        text: (el.textContent || el.value || '').trim(),
        id: el.id,
        className: el.className.slice(0, 50),
        visible: el.offsetParent !== null
      }));
    return {
      statusText: body.includes('결제완료') ? '결제완료' : body.includes('결제대기') ? '결제대기' : '알수없음',
      payBtns: btns,
      url: window.location.href
    };
  });

  console.log('현재 상태:', JSON.stringify(state1, null, 2));

  if (state1.statusText === '결제완료') {
    console.log('✅ 이미 결제완료 상태입니다!');
    await browser.close();
    process.exit(0);
  }

  // 결제하기 버튼 클릭 (visible한 것 중 첫 번째)
  const visibleBtn = state1.payBtns.find(b => b.visible);
  if (!visibleBtn) {
    console.log('⚠️  결제하기 버튼(visible)을 찾을 수 없음. 스크린샷 저장...');
    await page.screenshot({ path: '/tmp/finalize-debug.png', fullPage: true });
    console.log('   스크린샷: /tmp/finalize-debug.png');
    await browser.close();
    process.exit(1);
  }

  console.log(`\n🖱️  결제하기 클릭: ${JSON.stringify(visibleBtn)}`);

  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a, input[type="button"]'));
    for (const el of btns) {
      const t = (el.textContent || el.value || '').trim();
      if (t.includes('결제하기') && el.offsetParent !== null) {
        el.scrollIntoView({ block: 'center' });
        el.click();
        return true;
      }
    }
    return false;
  });

  console.log(clicked ? '✅ 결제하기 클릭' : '❌ 클릭 실패');
  await delay(2000);

  // 결제 완료 확인
  const state2 = await page.evaluate(() => {
    const body = document.body.innerText;
    return {
      status: body.includes('결제완료') ? '결제완료' : body.includes('결제대기') ? '결제대기' : '알수없음',
      url: window.location.href
    };
  });

  console.log('\n최종 상태:', JSON.stringify(state2));

  if (state2.status === '결제완료') {
    console.log('\n✅ 결제완료! kiosk-monitor 테스트 준비 완료');
    console.log('   node src/pickko-kiosk-monitor.js');
  } else {
    await page.screenshot({ path: '/tmp/finalize-final.png', fullPage: true });
    console.log('\n⚠️  결제 상태 불명확. 스크린샷: /tmp/finalize-final.png');
  }

  await browser.close();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
