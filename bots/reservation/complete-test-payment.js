/**
 * complete-test-payment.js — 테스트 예약 928862 결제 완료 처리
 * 이재룡 01035000586 / 예약중 → 결제완료
 */
const puppeteer = require('puppeteer');
const { loadSecrets } = require('./lib/secrets');
const { getPickkoLaunchOptions, setupDialogHandler } = require('./lib/browser');
const { loginToPickko } = require('./lib/pickko');
const delay = ms => new Promise(r => setTimeout(r, ms));

const SECRETS = loadSecrets();
const VIEW_URL = 'https://pickkoadmin.com/study/view/928862.html';
const norm = (s) => (s ?? '').replace(/[\s,]/g, '').trim();

(async () => {
  console.log('💳 테스트 예약 결제 완료 처리: 928862');
  const browser = await puppeteer.launch(getPickkoLaunchOptions());
  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  setupDialogHandler(page, console.log);

  await loginToPickko(page, SECRETS.pickko_id, SECRETS.pickko_pw, delay);
  console.log('✅ 픽코 로그인 완료');

  await page.goto(VIEW_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);

  // 현재 상태 확인
  const pageInfo = await page.evaluate(() => {
    const body = document.body.innerText;
    const hasTarget = body.includes('이재룡') || body.includes('01035000586');
    // 상태 확인 (결제완료 / 예약중)
    const statusMatch = body.match(/(결제완료|예약중|취소|환불)/);
    const status = statusMatch ? statusMatch[1] : '알수없음';
    // 결제하기 버튼
    const payBtn = document.querySelector('#study_order, a[onclick*="order"]');
    return {
      hasTarget,
      status,
      hasPayBtn: !!payBtn,
      payBtnPrice: payBtn?.getAttribute('price') || null,
      url: window.location.href
    };
  });

  console.log('현재 상태:', JSON.stringify(pageInfo, null, 2));

  if (!pageInfo.hasTarget) {
    console.log('⚠️  예약 정보를 찾을 수 없음 (예약이 이미 취소됐을 수 있음)');
    await browser.close();
    process.exit(1);
  }

  if (pageInfo.status === '결제완료') {
    console.log('✅ 이미 결제완료 상태입니다!');
    await browser.close();
    process.exit(0);
  }

  if (!pageInfo.hasPayBtn) {
    console.log('⚠️  결제하기 버튼을 찾을 수 없음. 스크린샷 저장...');
    await page.screenshot({ path: '/tmp/payment-debug.png', fullPage: true });
    console.log('   스크린샷: /tmp/payment-debug.png');
    await browser.close();
    process.exit(1);
  }

  console.log(`\n💳 결제 진행: 금액=${pageInfo.payBtnPrice}원`);

  // 결제하기 클릭
  const payBtnClicked = await page.evaluate(() => {
    const btn = document.querySelector('#study_order');
    if (btn) { btn.click(); return true; }
    // fallback: 텍스트로 찾기
    const btns = Array.from(document.querySelectorAll('button, a'));
    for (const b of btns) {
      if ((b.textContent || '').trim() === '결제하기') { b.click(); return true; }
    }
    return false;
  });

  console.log(payBtnClicked ? '✅ 결제하기 버튼 클릭' : '❌ 결제하기 버튼 클릭 실패');
  if (!payBtnClicked) {
    await browser.close();
    process.exit(1);
  }

  await delay(1500);

  // 결제 모달 확인
  const modalInfo = await page.evaluate(() => {
    const modal = document.querySelector('#order_write');
    if (!modal) return { visible: false };
    const totalEl = document.querySelector('#od_total_price3');
    const cashLabel = document.querySelector('label[for="pay_type1_2"]');
    return {
      visible: true,
      total: (totalEl?.textContent || '').trim(),
      hasCashOption: !!cashLabel
    };
  });

  console.log('결제 모달:', JSON.stringify(modalInfo));

  if (!modalInfo.visible) {
    console.log('⚠️  결제 모달이 열리지 않음');
    await page.screenshot({ path: '/tmp/payment-modal-debug.png', fullPage: true });
    await browser.close();
    process.exit(1);
  }

  // 현금 선택
  if (modalInfo.hasCashOption) {
    await page.waitForSelector('label[for="pay_type1_2"]', { timeout: 5000 });
    const labelBox = await page.$('label[for="pay_type1_2"]');
    await page.evaluate(() => document.querySelector('label[for="pay_type1_2"]')?.scrollIntoView({ block: 'center' }));
    await delay(200);
    const box = await labelBox.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await delay(300);
    }
    const isChecked = await page.evaluate(() => document.querySelector('#pay_type1_2')?.checked ?? false);
    console.log(`💳 현금 선택: ${isChecked ? '✅' : '❌'}`);
  }

  await delay(300);

  // 결제 확인 (총 결제금액 확인)
  const afterCash = await page.evaluate(() => {
    return (document.querySelector('#od_total_price3')?.textContent || '').trim();
  });
  console.log(`결제 총액: ${afterCash}`);

  // #pay_order 클릭 (결제 최종 확인)
  console.log('\n🔘 #pay_order 클릭 (최종 결제 확인)...');
  try {
    await page.waitForSelector('#pay_order', { timeout: 5000 });
    const payOrderBtn = await page.$('#pay_order');
    await page.evaluate(() => document.querySelector('#pay_order')?.scrollIntoView({ block: 'center' }));
    await delay(150);
    const pbox = await payOrderBtn.boundingBox();
    if (pbox) {
      await page.mouse.click(pbox.x + pbox.width / 2, pbox.y + pbox.height / 2);
      console.log('✅ #pay_order 클릭 완료');
    }
  } catch (e) {
    console.log(`❌ #pay_order 클릭 실패: ${e.message}`);
  }

  await delay(2000);

  // 최종 상태 확인
  const finalStatus = await page.evaluate(() => {
    const modalClosed = !document.querySelector('#order_write');
    const body = document.body.innerText;
    const statusMatch = body.match(/(결제완료|예약중)/);
    return {
      modalClosed,
      status: statusMatch ? statusMatch[1] : '알수없음',
      url: window.location.href
    };
  });

  console.log('\n최종 상태:', JSON.stringify(finalStatus, null, 2));

  if (finalStatus.status === '결제완료' || finalStatus.modalClosed) {
    console.log('\n✅ 결제 완료! 이제 kiosk-monitor 테스트 가능합니다.');
    console.log('   node src/pickko-kiosk-monitor.js');
  } else {
    console.log('\n⚠️  결제 상태 불명확. 수동 확인 필요.');
    await page.screenshot({ path: '/tmp/payment-final.png', fullPage: true });
    console.log('   스크린샷: /tmp/payment-final.png');
  }

  await browser.close();
})().catch(e => { console.error('❌', e.message); process.exit(1); });
