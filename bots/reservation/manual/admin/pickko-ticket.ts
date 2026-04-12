#!/usr/bin/env node
// @ts-nocheck

/**
 * pickko-ticket.js — 픽코 키오스크 이용권 추가 CLI
 */

const puppeteer = require('puppeteer');
const { delay, log } = require('../../lib/utils');
const { loadSecrets } = require('../../lib/secrets');
const { parseArgs } = require('../../lib/args');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../../lib/browser');
const { loginToPickko, findPickkoMember } = require('../../lib/pickko');
const { IS_DEV, IS_OPS } = require('../../../../packages/core/lib/env');
const { outputResult, fail } = require('../../lib/cli');
const { maskPhone, maskName } = require('../../lib/formatting');

const SECRETS = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;
const ARGS = parseArgs(process.argv);

const MODE = IS_OPS ? 'ops' : 'dev';
const DEV_WHITELIST = (process.env.DEV_WHITELIST_PHONES || '01035000586,01054350586')
  .split(',')
  .map((p) => p.trim())
  .filter((p) => /^\d{11}$/.test(p));

const TICKET_ALIASES = {
  '1h': '1시간', '2h': '2시간', '3h': '3시간', '4h': '4시간',
  '6h': '6시간', '8h': '8시간', '14h': '14시간',
  '30h': '30시간', '50h': '50시간',
  '14d': '14일권', '14일': '14일권',
  '28d': '28일권', '28일': '28일권',
};

const VALID_TICKETS = [
  '1시간', '2시간', '3시간', '4시간', '6시간', '8시간', '14시간',
  '30시간', '50시간', '14일권', '28일권',
];

if (!ARGS.phone || !ARGS.ticket) {
  fail('필수 인자 누락: --phone, --ticket\n사용법: node pickko-ticket.js --phone=01000000000 --ticket="3시간" [--count=1]');
}

const PHONE_RAW = ARGS.phone.replace(/\D/g, '');
if (!/^\d{10,11}$/.test(PHONE_RAW)) {
  fail(`전화번호 형식 오류: ${ARGS.phone} (10~11자리 숫자여야 함)`);
}

const ticketRaw = (ARGS.ticket || '').trim();
const TICKET_NAME = TICKET_ALIASES[ticketRaw] || ticketRaw;
if (!VALID_TICKETS.includes(TICKET_NAME)) {
  fail(`유효하지 않은 이용권: "${ticketRaw}"\n가능한 이용권: ${VALID_TICKETS.join(', ')}`);
}

const COUNT = Math.min(Math.max(parseInt(ARGS.count || '1', 10), 1), 9);
const DISCOUNT = process.argv.includes('--discount');
const REASON_RAW = (ARGS.reason || '').trim();
const REASON = REASON_RAW || '기타 할인';

if (['14일권', '28일권'].includes(TICKET_NAME) && COUNT > 1) {
  fail(`기간권(${TICKET_NAME})은 중복 방지를 위해 count=1만 허용됩니다.`);
}

if (IS_DEV && !DEV_WHITELIST.includes(PHONE_RAW)) {
  fail(`DEV 모드: 화이트리스트 번호만 허용 (입력: ${PHONE_RAW})\nOPS 모드 사용: MODE=ops node src/pickko-ticket.js ...`);
}

async function selectSeatTypeAndLoad(page) {
  log('\n[4단계] 자유석 선택 → 이용권 목록 로드');

  const stcNoValue = await page.evaluate(() => {
    const opt = Array.from(document.querySelectorAll('#stc_no option'))
      .find((o) => o.textContent.includes('자유석'));
    return opt ? opt.value : null;
  });
  if (!stcNoValue) throw new Error('#stc_no 자유석 옵션을 찾을 수 없음');

  await page.evaluate((val) => {
    const sel = document.querySelector('#stc_no');
    if (!sel) return;
    sel.value = val;
    if (typeof jQuery !== 'undefined') {
      jQuery(sel).trigger('change');
    } else {
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, stcNoValue);
  log(`  자유석 선택 완료 (stc_no=${stcNoValue})`);

  let loaded = false;
  for (let i = 0; i < 12; i++) {
    await delay(1000);
    const svcCount = await page.evaluate(() => {
      const sp = document.querySelector('#service_price');
      if (!sp) return 0;
      return sp.querySelectorAll('a.use_Y').length;
    });
    if (svcCount > 0) {
      log(`  ✅ 이용권 목록 로드 완료 (${svcCount}개, ${i + 1}초 소요)`);
      loaded = true;
      break;
    }
  }
  if (!loaded) throw new Error('이용권 목록 로드 실패 (12초 초과 — #service_price a.use_Y 없음)');
  log('  ✅ 이용권 목록 로드 완료');
}

async function waitForPayOrderEnabled(page, maxMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const enabled = await page.evaluate(() => {
      const btn = document.querySelector('#pay_order');
      return btn && !btn.className.includes('disabled');
    });
    if (enabled) return true;
    await delay(300);
  }
  return false;
}

async function addTicket(page, ticketName, count) {
  log(`\n[5단계] 이용권 추가: "${ticketName}" × ${count}`);

  const svcNo = await page.evaluate((name) => {
    const items = document.querySelectorAll('#service_price a.use_Y');
    for (const item of items) {
      const payName = (item.querySelector('.pay_name')?.textContent || '').replace(/\s+/g, '');
      if (payName.includes(name)) {
        const btn = item.querySelector('.svc_add_btn');
        return btn ? btn.getAttribute('svc_no') : null;
      }
    }
    return null;
  }, ticketName);

  if (!svcNo) throw new Error(`"${ticketName}" 이용권을 목록에서 찾을 수 없음`);
  log(`  svc_no=${svcNo} 확인`);

  for (let i = 1; i <= count; i++) {
    const clicked = await page.evaluate((no) => {
      const btn = document.querySelector(`.svc_add_btn[svc_no="${no}"]`);
      if (btn) { btn.click(); return true; }
      return false;
    }, svcNo);
    if (!clicked) throw new Error(`+ 버튼 클릭 실패 (svc_no=${svcNo}, ${i}/${count}번째)`);
    log(`  + 클릭 ${i}/${count}`);
    if (i < count) await delay(400);
  }

  const enabled = await waitForPayOrderEnabled(page, 8000);
  if (!enabled) throw new Error('이용권 추가 후 결제하기 버튼이 활성화되지 않음 (8초 초과)');
  log('  ✅ #pay_order 활성화 확인');
}

async function applyDiscount(page) {
  log('\n[5.5단계] 할인 추가');

  const priceStr = await page.evaluate(() => {
    const input = document.querySelector('input.price1');
    return input ? input.value : '';
  });
  const priceNum = priceStr.replace(/[^0-9]/g, '');
  if (!priceNum || priceNum === '0') throw new Error('이용권 금액을 주문에서 가져오지 못함 (input.price1)');
  log(`  이용권 금액: ${priceStr} → 할인 금액: ${priceNum}원`);

  const dcClicked = await page.evaluate(() => {
    const btn = document.querySelector('#add_dc');
    if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); return true; }
    return false;
  });
  if (!dcClicked) throw new Error('#add_dc 할인 추가 버튼 없음');
  await delay(500);

  await page.evaluate(() => {
    const input = document.querySelector('#add_item_dsc');
    if (input) {
      input.value = '기타할인';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  await page.evaluate((price) => {
    const input = document.querySelector('#add_item_price');
    if (input) {
      input.value = price;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, priceNum);
  await delay(200);

  const okClicked = await page.evaluate(() => {
    const btn = document.querySelector('#add_item_ok');
    if (btn && btn.offsetParent !== null) { btn.click(); return true; }
    return false;
  });
  if (!okClicked) throw new Error('#add_item_ok 할인 추가 확인 버튼 없음');
  await delay(800);

  const totalText = await page.evaluate(() =>
    (document.querySelector('.total_price')?.innerText || '').replace(/\n/g, ' '),
  );
  log(`  합계금액 확인: ${totalText}`);
  log('  ✅ 할인 추가 완료');
}

async function fillOrderMemo(page, reason) {
  log(`\n[6.5단계] 주문 메모 입력: "${reason}"`);
  await page.evaluate((text) => {
    const ta = document.querySelector('#od_memo');
    if (ta) {
      ta.value = text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, reason);
  log('  ✅ 주문 메모 입력 완료');
  await delay(200);
}

async function verifyOrderSummary(page, ticketName) {
  log('\n[6단계] 주문정보 확인');
  await delay(500);

  const found = await page.evaluate((name) => document.body.innerText.includes(name), ticketName);
  if (found) log(`  ✅ 주문정보에 "${ticketName}" 확인됨`);
  else log(`  ⚠️ 페이지에서 "${ticketName}" 텍스트 미확인 — 계속 진행`);
}

async function selectCash(page) {
  log('\n[7단계] 현금 결제수단 선택');

  let cashOk = await page.evaluate(() => {
    const label = document.querySelector('label[for="pay_type1_2"]');
    if (label) { label.click(); return true; }
    for (const l of document.querySelectorAll('label')) {
      if ((l.textContent || '').trim() === '현금') { l.click(); return true; }
    }
    return false;
  });

  if (!cashOk) {
    try {
      await page.waitForSelector('label[for="pay_type1_2"]', { timeout: 3000 });
      const label = await page.$('label[for="pay_type1_2"]');
      if (label) {
        const box = await label.boundingBox();
        if (box) {
          await page.evaluate(() => document.querySelector('label[for="pay_type1_2"]')?.scrollIntoView({ block: 'center' }));
          await delay(150);
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
          cashOk = await page.evaluate(() => document.querySelector('#pay_type1_2')?.checked ?? false);
        }
      }
    } catch (e) {
      log(`  ⚠️ 현금 선택 실패: ${e.message}`);
    }
  }

  log(cashOk ? '  ✅ 현금 선택 완료' : '  ⚠️ 현금 선택 불확실 — 계속 진행');
  await delay(300);
  return cashOk;
}

async function clickMainPayButton(page) {
  log('\n[8단계] #pay_order 결제하기 클릭');

  const clicked = await page.evaluate(() => {
    const btn = document.querySelector('#pay_order');
    if (btn && !btn.className.includes('disabled') && btn.offsetParent !== null) {
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      return true;
    }
    return false;
  });

  if (!clicked) throw new Error('#pay_order 결제하기 버튼 클릭 실패 (없거나 비활성)');
  log('  ✅ #pay_order 클릭 (안내 팝업은 setupDialogHandler 자동처리)');
  await delay(1200);
}

async function handlePaymentPopups(page) {
  log('\n[9단계] 결제 완료 처리');

  for (let round = 1; round <= 8; round++) {
    await delay(600);

    const payStartClicked = await page.evaluate(() => {
      const btn = document.querySelector('.pay_start');
      if (btn && btn.offsetParent !== null) {
        btn.scrollIntoView({ block: 'center' });
        btn.click();
        return true;
      }
      return false;
    });
    if (payStartClicked) {
      log(`  ✅ .pay_start 결제하기 클릭 (round=${round})`);
      await delay(1500);
      return;
    }

    const receiptFound = await page.evaluate(() => !!document.querySelector('.receipt_btn'));
    if (receiptFound) {
      log(`  ✅ 0원 결제 완료 (영수증 출력 버튼 확인, round=${round})`);
      return;
    }
  }

  throw new Error('결제 완료 확인 실패 (.pay_start 미등장, receipt_btn 미등장)');
}

async function main() {
  const phoneFormatted = PHONE_RAW.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
  log(`\n🎫 픽코 이용권 추가: ${TICKET_NAME} × ${COUNT} → ${maskPhone(PHONE_RAW)}`);
  log(`🔧 MODE: ${MODE.toUpperCase()}`);

  let browser;
  try {
    browser = await puppeteer.launch(getPickkoLaunchOptions());
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, log);

    log('\n[1단계] 픽코 로그인');
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log('  ✅ 로그인 완료');

    log('\n[2단계] mb_no 조회');
    const { found, mbNo, name: pickkName } = await findPickkoMember(page, PHONE_RAW, delay);
    log(`  회원 검색 결과: found=${found}, mb_no=${mbNo}, name=${maskName(pickkName)}`);
    if (!found || !mbNo) fail(`회원을 찾을 수 없음: ${PHONE_RAW} (픽코 미등록 회원)`);
    log(`  ✅ mb_no=${mbNo} | 픽코 이름: ${pickkName || '미확인'}`);

    log(`\n[3단계] 회원 상세 페이지: /member/view/${mbNo}.html`);
    await page.goto(`https://pickkoadmin.com/member/view/${mbNo}.html`, {
      waitUntil: 'load',
    });
    await delay(2000);

    const memberName = await page.evaluate(() => {
      const nameInput = document.querySelector('input[name="mb_name"]');
      if (nameInput && nameInput.value) return nameInput.value.trim();
      return null;
    }) || pickkName;
    log(`  이용권 추가 대상: ${maskName(memberName) || '(이름 미확인)'} (mb_no=${mbNo}, ${maskPhone(PHONE_RAW)})`);

    await selectSeatTypeAndLoad(page);
    await addTicket(page, TICKET_NAME, COUNT);

    if (DISCOUNT) {
      await applyDiscount(page);
    }

    await verifyOrderSummary(page, TICKET_NAME);

    if (DISCOUNT || REASON_RAW) {
      await fillOrderMemo(page, REASON);
    }

    await selectCash(page);
    await clickMainPayButton(page);
    await handlePaymentPopups(page);

    await delay(500);

    const targetLabel = memberName ? `${memberName} (${phoneFormatted})` : phoneFormatted;
    const discountNote = DISCOUNT ? ` (전액할인 — ${REASON})` : '';
    const doneMsg = `이용권 추가 완료: ${targetLabel}\n이용권: ${TICKET_NAME} × ${COUNT}${discountNote}`;
    log(`\n✅ ${doneMsg}`);
    outputResult({ success: true, message: doneMsg });
  } catch (err) {
    log(`❌ 오류: ${err.message}`);
    fail(err.message);
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
}

module.exports = {
  selectSeatTypeAndLoad,
  waitForPayOrderEnabled,
  addTicket,
  applyDiscount,
  fillOrderMemo,
  verifyOrderSummary,
  selectCash,
  clickMainPayButton,
  handlePaymentPopups,
  main,
};

main().catch((err) => {
  log(`❌ 치명 오류: ${err.message}`);
  fail(err.message);
});
