/**
 * 이재룡 테스트 예약 취소 (주문번호 928862)
 */
const puppeteer = require('puppeteer');
const { getPickkoLaunchOptions, setupDialogHandler } = require('./lib/browser');
const { loginToPickko } = require('./lib/pickko');
const { loadSecrets } = require('./lib/secrets');
const { delay, log } = require('./lib/utils');

const SECRETS = loadSecrets();

(async () => {
  const browser = await puppeteer.launch(getPickkoLaunchOptions());
  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  page.setDefaultTimeout(30000);
  setupDialogHandler(page, log);

  await loginToPickko(page, SECRETS.pickko_id, SECRETS.pickko_pw, delay);
  log('✅ 픽코 로그인 완료');

  // 주문 상세 페이지로 이동
  await page.goto('https://pickkoadmin.com/study/view/928862.html', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);

  log('URL: ' + page.url());

  // 현재 상태 확인
  const status = await page.evaluate(() => {
    const text = document.body.innerText || '';
    const statusMatch = text.match(/결제완료|취소|환불|대기/);
    return { status: statusMatch ? statusMatch[0] : '알수없음', hasCancel: !!document.querySelector('[class*="cancel"], button, a') };
  });
  log('현재 상태: ' + JSON.stringify(status));

  await page.screenshot({ path: '/tmp/cancel-before.png' });
  log('스크린샷: /tmp/cancel-before.png');

  // 취소 버튼 찾기
  const cancelResult = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
    const candidates = btns.filter(b => {
      const text = (b.textContent || b.value || '').trim();
      return text.includes('취소') || text.includes('환불') || text.includes('cancel');
    });
    return candidates.map(b => ({
      tag: b.tagName,
      text: (b.textContent || b.value || '').trim().slice(0, 30),
      id: b.id || '',
      cls: (b.className || '').slice(0, 60)
    }));
  });
  log('취소 버튼 후보: ' + JSON.stringify(cancelResult));

  if (cancelResult.length === 0) {
    log('❌ 취소 버튼 없음');
    await browser.close();
    return;
  }

  // 첫 번째 취소 버튼 클릭
  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
    for (const b of btns) {
      const text = (b.textContent || b.value || '').trim();
      if (text.includes('취소') || text.includes('환불')) {
        b.click();
        return { clicked: true, text };
      }
    }
    return { clicked: false };
  });
  log('취소 버튼 클릭: ' + JSON.stringify(clicked));
  await delay(2000);

  await page.screenshot({ path: '/tmp/cancel-after.png' });
  log('스크린샷: /tmp/cancel-after.png');

  // 확인 팝업/모달 처리
  const confirmResult = await page.evaluate(() => {
    // 확인 버튼 찾기
    const btns = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'));
    const confirmBtns = btns.filter(b => {
      const text = (b.textContent || b.value || '').trim();
      return text === '확인' || text === 'OK' || text === '예' || text.includes('취소확인') || text.includes('환불확인');
    });
    if (confirmBtns.length > 0) {
      confirmBtns[0].click();
      return { clicked: true, text: (confirmBtns[0].textContent || confirmBtns[0].value || '').trim() };
    }
    return { clicked: false };
  });
  log('확인 팝업: ' + JSON.stringify(confirmResult));
  await delay(2000);

  await page.screenshot({ path: '/tmp/cancel-final.png' });
  log('최종 스크린샷: /tmp/cancel-final.png');

  const finalStatus = await page.evaluate(() => {
    return (document.body.innerText || '').match(/결제완료|취소|환불|대기/) ? 
      (document.body.innerText.match(/결제완료|취소|환불|대기/)[0]) : '알수없음';
  });
  log('최종 상태: ' + finalStatus);

  await browser.close();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
