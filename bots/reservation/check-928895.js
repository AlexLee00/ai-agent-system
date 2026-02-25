/**
 * 928895 결제대기 → 결제완료 처리
 * label[for="pay_type1_2"] 현금 선택 → 결제하기
 */
const puppeteer = require('puppeteer');
const { getPickkoLaunchOptions, setupDialogHandler } = require('./lib/browser');
const { loginToPickko } = require('./lib/pickko');
const { loadSecrets } = require('./lib/secrets');
const { delay, log } = require('./lib/utils');
const SECRETS = loadSecrets();

(async () => {
  const browser = await puppeteer.launch({ ...getPickkoLaunchOptions(), headless: false });
  const page = (await browser.pages())[0] || await browser.newPage();
  page.setDefaultTimeout(30000);
  setupDialogHandler(page, log);

  await loginToPickko(page, SECRETS.pickko_id, SECRETS.pickko_pw, delay);
  log('✅ 로그인 완료');

  // 928895 상세 페이지 — 현재 결제 상태 확인
  await page.goto('https://pickkoadmin.com/study/view/928895.html', { waitUntil: 'networkidle2' });
  await delay(2000);

  const curState = await page.evaluate(() => {
    const clean = s => (s ?? '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('tbody tr, tr'))
      .map(tr => clean(tr.textContent).slice(0, 120))
      .filter(t => t.includes('결제') || t.includes('현금') || t.includes('카드'));
  });
  log('현재 결제 행:');
  curState.forEach(r => log('  ' + r));

  // 주문상세 href 추출
  const orderHref = await page.evaluate(() => {
    const clean = s => (s ?? '').replace(/\s+/g, ' ').trim();
    const trs = Array.from(document.querySelectorAll('tbody tr, tr'));
    for (const tr of trs) {
      const rowText = clean(tr.textContent);
      // 결제대기 행 우선
      if (!rowText.includes('결제대기')) continue;
      for (const btn of tr.querySelectorAll('a')) {
        const t = clean(btn.textContent || '');
        if (t.includes('주문상세')) return btn.href || null;
      }
    }
    // fallback: 아무 주문상세
    for (const tr of document.querySelectorAll('tbody tr, tr')) {
      for (const btn of tr.querySelectorAll('a')) {
        const t = (btn.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.includes('주문상세')) return btn.href || null;
      }
    }
    return null;
  });
  log('주문상세 href: ' + orderHref);
  if (!orderHref) throw new Error('주문상세 href 없음');

  // 모달 열기
  await page.goto(orderHref, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await delay(2000);
  await page.screenshot({ path: '/tmp/modal-state.png', fullPage: false });
  log('모달 스크린샷: /tmp/modal-state.png');

  // 결제항목 버튼 확인
  const modalBtns = await page.evaluate(() => {
    const clean = s => (s ?? '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]'))
      .map(b => ({ text: clean(b.textContent || b.value || ''), id: b.id || '', cls: (b.className || '').slice(0, 50) }))
      .filter(b => b.text.length > 0 && b.text.length < 20);
  });
  log('모달 버튼: ' + JSON.stringify(modalBtns));

  // pay_start 클릭 (결제항목 행의 결제하기)
  const payStartClicked = await page.evaluate(() => {
    const btn = document.querySelector('.pay_start');
    if (btn) { btn.click(); return { clicked: true, cls: btn.className }; }
    return { clicked: false };
  });
  log('pay_start 클릭: ' + JSON.stringify(payStartClicked));

  if (!payStartClicked.clicked) {
    // pay_start 없으면 study_order 클릭
    const studyOrderClicked = await page.evaluate(() => {
      const btn = document.querySelector('#study_order');
      if (btn) { btn.click(); return { clicked: true, id: btn.id }; }
      return { clicked: false };
    });
    log('study_order 클릭: ' + JSON.stringify(studyOrderClicked));
    if (!studyOrderClicked.clicked) throw new Error('결제하기 버튼 없음 (pay_start, study_order 모두 없음)');
  }
  await delay(1500);

  // 팝업 스크린샷
  await page.screenshot({ path: '/tmp/pay-popup2.png', fullPage: false });
  log('결제 팝업 스크린샷: /tmp/pay-popup2.png');

  // 현금 선택 — label[for="pay_type1_2"] 사용 (pickko-accurate.js의 clickCashMouse 동일 패턴)
  try {
    await page.waitForSelector('label[for="pay_type1_2"]', { timeout: 5000 });
    const labelHandle = await page.$('label[for="pay_type1_2"]');
    if (labelHandle) {
      await page.evaluate(() => {
        const el = document.querySelector('label[for="pay_type1_2"]');
        if (el) el.scrollIntoView({ block: 'center', inline: 'center' });
      });
      await delay(200);
      const box = await labelHandle.boundingBox();
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        await delay(300);
      }
    }
    const isChecked = await page.evaluate(() => document.querySelector('#pay_type1_2')?.checked ?? false);
    log(`💳 현금 선택: checked=${isChecked}`);
  } catch (e) {
    log('⚠️ label[for="pay_type1_2"] 없음: ' + e.message);
    // fallback: 현금 텍스트 버튼/탭 클릭
    const cashFallback = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('a, button, span, li'));
      for (const b of btns) {
        const t = (b.textContent || '').trim();
        if (t === '현금') { b.click(); return { clicked: true, tag: b.tagName }; }
      }
      return { clicked: false };
    });
    log('현금 fallback: ' + JSON.stringify(cashFallback));
  }
  await delay(300);

  // 결제하기 (#pay_order) — page.click 사용
  let payOrderOk = false;
  try {
    await page.waitForSelector('#pay_order', { timeout: 3000 });
    await page.click('#pay_order');
    payOrderOk = true;
    log('✅ #pay_order 클릭 완료');
  } catch (e) {
    log('⚠️ #pay_order 없음, evaluate로 결제하기 클릭 시도');
    payOrderOk = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'));
      const btn = btns.find(b => {
        const t = (b.textContent || b.value || '').trim();
        return t === '결제하기';
      });
      if (btn) { btn.click(); return true; }
      return false;
    });
    log('결제하기 evaluate: ' + payOrderOk);
  }
  await delay(2000);

  // 확인 팝업 처리
  const confirmResult = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'));
    const btn = btns.find(b => {
      const t = (b.textContent || b.value || '').trim();
      return t === '확인' || t === 'OK';
    });
    if (btn) { btn.click(); return { clicked: true, text: (btn.textContent || btn.value || '').trim() }; }
    return { clicked: false };
  });
  log('확인 팝업: ' + JSON.stringify(confirmResult));
  await delay(1000);

  await page.screenshot({ path: '/tmp/after-pay2.png', fullPage: false });
  log('결제 후 스크린샷: /tmp/after-pay2.png');

  // 최종 상태 확인
  await page.goto('https://pickkoadmin.com/study/view/928895.html', { waitUntil: 'networkidle2' });
  await delay(2000);
  const finalState = await page.evaluate(() => {
    const clean = s => (s ?? '').replace(/\s+/g, ' ').trim();
    return Array.from(document.querySelectorAll('tbody tr, tr'))
      .map(tr => clean(tr.textContent).slice(0, 120))
      .filter(t => t.includes('결제') || t.includes('현금') || t.includes('카드'));
  });
  log('최종 결제 상태:');
  finalState.forEach(r => log('  ' + r));
  await page.screenshot({ path: '/tmp/final-state.png', fullPage: false });

  await browser.close();
})().catch(e => { console.error(e.message); process.exit(1); });
