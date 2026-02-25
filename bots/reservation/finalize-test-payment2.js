/**
 * finalize-test-payment2.js — 결제 폼 → 결제하기 클릭
 * 스터디룸A1 결제 폼에서 현금 선택 후 최종 결제하기 클릭
 */
const puppeteer = require('puppeteer');
const { loadSecrets } = require('./lib/secrets');
const { getPickkoLaunchOptions, setupDialogHandler } = require('./lib/browser');
const { loginToPickko } = require('./lib/pickko');
const delay = ms => new Promise(r => setTimeout(r, ms));

const SECRETS = loadSecrets();
const ORDER_URL = 'https://pickkoadmin.com/study/view/928862.html#/order/view/21160912';

(async () => {
  console.log('💳 결제 폼 → 결제하기 최종 클릭');
  const browser = await puppeteer.launch(getPickkoLaunchOptions());
  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  setupDialogHandler(page, console.log);

  await loginToPickko(page, SECRETS.pickko_id, SECRETS.pickko_pw, delay);
  console.log('✅ 픽코 로그인 완료');

  await page.goto(ORDER_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);

  // study_order (결제하기) 클릭 → 결제 폼 열기
  console.log('1. 결제하기 버튼 클릭 (폼 열기)');
  await page.evaluate(() => {
    const btn = document.querySelector('#study_order');
    if (btn) btn.click();
  });
  await delay(2000);

  // 결제 폼 확인
  const formInfo = await page.evaluate(() => {
    // 현금 탭 찾기
    const tabs = Array.from(document.querySelectorAll('a, button, label'))
      .filter(el => el.textContent.trim() === '현금' && el.offsetParent !== null)
      .map(el => ({ tag: el.tagName, text: el.textContent.trim(), className: el.className.slice(0, 50) }));

    // 결제하기 버튼 (최종)
    const finalBtns = Array.from(document.querySelectorAll('button, a, input[type="button"]'))
      .filter(el => {
        const t = (el.textContent || el.value || '').trim();
        return t === '결제하기' && el.offsetParent !== null;
      })
      .map(el => ({ tag: el.tagName, text: (el.textContent || el.value || '').trim(), className: el.className.slice(0, 60), id: el.id }));

    return { tabs, finalBtns };
  });

  console.log('현금 탭:', JSON.stringify(formInfo.tabs));
  console.log('결제하기 버튼:', JSON.stringify(formInfo.finalBtns));

  // 현금 탭 클릭
  if (formInfo.tabs.length > 0) {
    console.log('2. 현금 탭 클릭');
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('a, button, label'));
      for (const el of tabs) {
        if (el.textContent.trim() === '현금' && el.offsetParent !== null) {
          el.click();
          return true;
        }
      }
      return false;
    });
    await delay(500);
  }

  // 결제하기 (최종) - id가 없는 큰 버튼 (pay_start or similar)
  console.log('3. 최종 결제하기 클릭');
  const finalClicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a, input[type="button"]'));
    // pay_start 클래스 먼저 시도
    for (const el of btns) {
      if (el.className && el.className.includes('pay_start') && el.offsetParent !== null) {
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { clicked: true, method: 'pay_start' };
      }
    }
    // 대형 결제하기 버튼 (id=study_order 제외)
    for (const el of btns) {
      const t = (el.textContent || el.value || '').trim();
      if (t === '결제하기' && el.offsetParent !== null && el.id !== 'study_order') {
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { clicked: true, method: 'text-match', className: el.className.slice(0, 40) };
      }
    }
    return { clicked: false };
  });

  console.log('최종 클릭 결과:', JSON.stringify(finalClicked));
  await delay(3000);

  // 최종 상태 확인
  const finalState = await page.evaluate(() => {
    const body = document.body.innerText;
    const modalClosed = !document.querySelector('[class*="payment_form"], .modal_payment');
    return {
      status: body.includes('결제완료') ? '결제완료' :
              body.includes('결제대기') ? '결제대기' : '알수없음',
      url: window.location.href,
      modalClosed
    };
  });

  console.log('\n최종 상태:', JSON.stringify(finalState));
  await page.screenshot({ path: '/tmp/finalize2-final.png', fullPage: true });
  console.log('스크린샷: /tmp/finalize2-final.png');

  if (finalState.status === '결제완료') {
    console.log('\n✅ 결제완료! kiosk-monitor 테스트 준비 완료');
  } else {
    console.log('\n⚠️  상태 불명확. 스크린샷 확인 필요.');
  }

  await browser.close();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
