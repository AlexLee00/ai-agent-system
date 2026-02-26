#!/usr/bin/env node

/**
 * pickko-ticket.js — 픽코 키오스크 이용권 추가 CLI
 *
 * 사용법:
 *   node src/pickko-ticket.js --phone=01012345678 --ticket="3시간" [--count=1]
 *   node src/pickko-ticket.js --phone=01012345678 --ticket="3시간" --discount [--reason="리뷰체험단"]
 *
 * 이용권 종류 (--ticket 값):
 *   1시간, 2시간, 3시간, 4시간, 6시간, 8시간, 14시간(심야)
 *   30시간, 50시간
 *   14일권, 28일권
 *
 * 단축 표기:
 *   1h → 1시간 / 3h → 3시간 / 14h → 14시간
 *   30h → 30시간 / 50h → 50시간
 *   14d → 14일권 / 28d → 28일권
 *
 * 할인 옵션:
 *   --discount        이용권 전액 할인 (0원 처리)
 *   --reason="사유"   주문 메모 및 할인 사유 (기본값: "기타 할인")
 *
 * 출력 (stdout JSON):
 *   { success: true,  message: "이용권 추가 완료: ..." }
 *   { success: false, message: "오류 내용" }
 *
 * 흐름:
 *   [1] 픽코 로그인
 *   [2] 전화번호로 mb_no 조회 (study/write.html 모달)
 *   [3] 회원 상세 페이지 진입
 *   [4] 자유석 선택 → 이용권 목록 로드
 *   [5] 이용권 + 버튼 클릭 (count 회)
 *   [5.5] (--discount 시) 할인 추가 (#add_dc → #add_item_dsc/price → #add_item_ok)
 *   [6] 주문정보 확인
 *   [6.5] (--discount 또는 --reason 시) 주문 메모 입력 (#od_memo)
 *   [7] 현금 선택
 *   [8] 결제하기 클릭
 *   [9] 팝업 처리 (안내확인 → .pay_start 결제하기 → 완료확인)
 */

const puppeteer = require('puppeteer');
const { delay, log } = require('../lib/utils');
const { loadSecrets } = require('../lib/secrets');
const { parseArgs } = require('../lib/args');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../lib/browser');
const { loginToPickko, findPickkoMember } = require('../lib/pickko');

const SECRETS = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;
const ARGS = parseArgs(process.argv);

const MODE = (process.env.MODE || 'dev').toLowerCase();
const DEV_WHITELIST = (process.env.DEV_WHITELIST_PHONES || '01035000586,01054350586')
  .split(',').map(p => p.trim()).filter(p => /^\d{11}$/.test(p));

// ── 이용권 단축 표기 ─────────────────────────────────────────────────────

const TICKET_ALIASES = {
  '1h': '1시간',  '2h': '2시간',  '3h': '3시간',  '4h': '4시간',
  '6h': '6시간',  '8h': '8시간',  '14h': '14시간',
  '30h': '30시간', '50h': '50시간',
  '14d': '14일권', '14일': '14일권',
  '28d': '28일권', '28일': '28일권',
};

const VALID_TICKETS = [
  '1시간', '2시간', '3시간', '4시간', '6시간', '8시간', '14시간',
  '30시간', '50시간', '14일권', '28일권',
];

// ── 출력 헬퍼 ────────────────────────────────────────────────────────────

const { outputResult, fail } = require('../lib/cli');

// ── 입력 검증 ────────────────────────────────────────────────────────────

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

// ⚠️ 이용권 중복 결제 주의:
// - 시간권(1h/2h/3h…): 결제대기 중복 시 1개 결제 완료하면 나머지 자동 삭제 (시스템 보호)
// - 기간권(14일권/28일권): 중복 결제대기 → 중복 완료 가능 → count=1 고정 강제
if (['14일권', '28일권'].includes(TICKET_NAME) && COUNT > 1) {
  fail(`기간권(${TICKET_NAME})은 중복 방지를 위해 count=1만 허용됩니다.`);
}

// ── DEV 모드 보호 ────────────────────────────────────────────────────────

if (MODE === 'dev' && !DEV_WHITELIST.includes(PHONE_RAW)) {
  fail(`DEV 모드: 화이트리스트 번호만 허용 (입력: ${PHONE_RAW})\nOPS 모드 사용: MODE=ops node src/pickko-ticket.js ...`);
}

// ── [2단계] mb_no 조회 → lib/pickko.findPickkoMember 공통 함수 사용 ──────

// ── [4단계] 자유석 선택 + 이용권 목록 로드 ──────────────────────────────

async function selectSeatTypeAndLoad(page) {
  log('\n[4단계] 자유석 선택 → 이용권 목록 로드');

  // stc_no 에서 "자유석" option value 추출
  const stcNoValue = await page.evaluate(() => {
    const opt = Array.from(document.querySelectorAll('#stc_no option'))
      .find(o => o.textContent.includes('자유석'));
    return opt ? opt.value : null;
  });
  if (!stcNoValue) throw new Error('#stc_no 자유석 옵션을 찾을 수 없음');

  // stc_no 선택 + change 이벤트 강제 발생 (jQuery trigger 포함)
  await page.evaluate((val) => {
    const sel = document.querySelector('#stc_no');
    if (!sel) return;
    sel.value = val;
    // jQuery trigger (픽코 어드민은 jQuery 사용)
    if (typeof jQuery !== 'undefined') {
      jQuery(sel).trigger('change');
    } else {
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, stcNoValue);
  log(`  자유석 선택 완료 (stc_no=${stcNoValue})`);

  // service_price 이용권 목록 로드 대기 (AJAX 응답 폴링, 최대 12초)
  let loaded = false;
  for (let i = 0; i < 12; i++) {
    await delay(1000);
    const svcCount = await page.evaluate(() => {
      const sp = document.querySelector('#service_price');
      if (!sp) return 0;
      // 이용권 목록이 없습니다. span이 사라졌거나 use_Y 링크가 생겼으면 로드 완료
      const hasEmpty = sp.querySelector('span.empty');
      const hasItems = sp.querySelectorAll('a.use_Y').length;
      return hasItems;
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

// ── 결제하기 버튼 enabled 폴링 ───────────────────────────────────────────
// #pay_order 클래스에 'disabled'가 사라질 때까지 대기 (+ 클릭 후 AJAX 반영 ~3초)
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

// ── [5단계] 이용권 + 버튼 클릭 ──────────────────────────────────────────

async function addTicket(page, ticketName, count) {
  log(`\n[5단계] 이용권 추가: "${ticketName}" × ${count}`);

  // pay_name 텍스트로 svc_no 탐색
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

  // + 클릭 후 #pay_order enabled 폴링 (AJAX 반영까지 최대 8초)
  const enabled = await waitForPayOrderEnabled(page, 8000);
  if (!enabled) throw new Error('이용권 추가 후 결제하기 버튼이 활성화되지 않음 (8초 초과)');
  log('  ✅ #pay_order 활성화 확인');
}

// ── [5.5단계] 할인 추가 (--discount 플래그 시) ───────────────────────────
// 주문에서 이용권 금액을 읽어 전액 할인 (합계 0원)

async function applyDiscount(page) {
  log('\n[5.5단계] 할인 추가');

  // 주문 아이템 금액 추출 (input.price1 class)
  const priceStr = await page.evaluate(() => {
    const input = document.querySelector('input.price1');
    return input ? input.value : '';
  });
  const priceNum = priceStr.replace(/[^0-9]/g, '');
  if (!priceNum || priceNum === '0') throw new Error('이용권 금액을 주문에서 가져오지 못함 (input.price1)');
  log(`  이용권 금액: ${priceStr} → 할인 금액: ${priceNum}원`);

  // #add_dc 할인 추가 버튼 클릭
  const dcClicked = await page.evaluate(() => {
    const btn = document.querySelector('#add_dc');
    if (btn) { btn.scrollIntoView({ block: 'center' }); btn.click(); return true; }
    return false;
  });
  if (!dcClicked) throw new Error('#add_dc 할인 추가 버튼 없음');
  await delay(500);

  // 할인 사유: "기타할인" 입력
  await page.evaluate(() => {
    const input = document.querySelector('#add_item_dsc');
    if (input) {
      input.value = '기타할인';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  // 할인 금액: 이용권 전액 입력
  await page.evaluate((price) => {
    const input = document.querySelector('#add_item_price');
    if (input) {
      input.value = price;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }, priceNum);
  await delay(200);

  // #add_item_ok 할인 추가 확인 클릭
  const okClicked = await page.evaluate(() => {
    const btn = document.querySelector('#add_item_ok');
    if (btn && btn.offsetParent !== null) { btn.click(); return true; }
    return false;
  });
  if (!okClicked) throw new Error('#add_item_ok 할인 추가 확인 버튼 없음');
  await delay(800);

  // 합계금액 0원 확인
  const totalText = await page.evaluate(() =>
    (document.querySelector('.total_price')?.innerText || '').replace(/\n/g, ' ')
  );
  log(`  합계금액 확인: ${totalText}`);
  log('  ✅ 할인 추가 완료');
}

// ── [6.5단계] 주문 메모 입력 ─────────────────────────────────────────────

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

// ── [6단계] 주문정보 확인 ────────────────────────────────────────────────

async function verifyOrderSummary(page, ticketName) {
  log('\n[6단계] 주문정보 확인');
  await delay(500);

  const found = await page.evaluate((name) => document.body.innerText.includes(name), ticketName);
  if (found) log(`  ✅ 주문정보에 "${ticketName}" 확인됨`);
  else log(`  ⚠️ 페이지에서 "${ticketName}" 텍스트 미확인 — 계속 진행`);
}

// ── [7단계] 현금 결제수단 선택 ──────────────────────────────────────────

async function selectCash(page) {
  log('\n[7단계] 현금 결제수단 선택');

  // 방법 1: label[for="pay_type1_2"] 직접 클릭
  let cashOk = await page.evaluate(() => {
    const label = document.querySelector('label[for="pay_type1_2"]');
    if (label) { label.click(); return true; }
    // 방법 2: "현금" 텍스트 라벨 탐색
    for (const l of document.querySelectorAll('label')) {
      if ((l.textContent || '').trim() === '현금') { l.click(); return true; }
    }
    return false;
  });

  if (!cashOk) {
    // 방법 3: 마우스 클릭
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

// ── [8단계] 결제하기 버튼 클릭 (메인 페이지, #pay_order) ──────────────

async function clickMainPayButton(page) {
  log('\n[8단계] #pay_order 결제하기 클릭');

  // #pay_order: enabled 상태([5단계]에서 이미 확인됨) → 클릭
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

// ── [9단계] 결제 완료 처리 ───────────────────────────────────────────────
// 유료 결제: #pay_order 클릭 → native alert → .pay_start 등장 → 클릭 → 결제완료
// 0원 결제:  #pay_order 클릭 → native alert → 즉시 완료 (receipt_btn 등장, .pay_start 없음)

async function handlePaymentPopups(page) {
  log('\n[9단계] 결제 완료 처리');

  for (let round = 1; round <= 8; round++) {
    await delay(600);

    // 유료 결제: .pay_start 버튼 등장 → 클릭
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

    // 0원 결제: receipt_btn 등장 → 이미 완료
    const receiptFound = await page.evaluate(() =>
      !!document.querySelector('.receipt_btn')
    );
    if (receiptFound) {
      log(`  ✅ 0원 결제 완료 (영수증 출력 버튼 확인, round=${round})`);
      return;
    }
  }

  throw new Error('결제 완료 확인 실패 (.pay_start 미등장, receipt_btn 미등장)');
}

// ── main ─────────────────────────────────────────────────────────────────

async function main() {
  const phoneFormatted = PHONE_RAW.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3');
  log(`\n🎫 픽코 이용권 추가: ${TICKET_NAME} × ${COUNT} → ${phoneFormatted}`);
  log(`🔧 MODE: ${MODE.toUpperCase()}`);

  let browser;
  try {
    browser = await puppeteer.launch(getPickkoLaunchOptions());
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, log);

    // [1단계] 로그인
    log('\n[1단계] 픽코 로그인');
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log('  ✅ 로그인 완료');

    // [2단계] mb_no 조회 (lib/pickko.findPickkoMember 공통 함수)
    log('\n[2단계] mb_no 조회');
    const { found, mbNo, name: pickkName } = await findPickkoMember(page, PHONE_RAW, delay);
    log(`  회원 검색 결과: found=${found}, mb_no=${mbNo}, name=${pickkName}`);
    if (!found || !mbNo) fail(`회원을 찾을 수 없음: ${PHONE_RAW} (픽코 미등록 회원)`);
    log(`  ✅ mb_no=${mbNo} | 픽코 이름: ${pickkName || '미확인'}`);

    // [3단계] 회원 상세 페이지 진입 + 회원 이름 확인
    log(`\n[3단계] 회원 상세 페이지: /member/view/${mbNo}.html`);
    await page.goto(`https://pickkoadmin.com/member/view/${mbNo}.html`, {
      waitUntil: 'load',
    });
    await delay(2000);

    // 회원 이름 확인 (member view에서 추가 검증)
    const memberName = await page.evaluate(() => {
      const nameInput = document.querySelector('input[name="mb_name"]');
      if (nameInput && nameInput.value) return nameInput.value.trim();
      return null;
    }) || pickkName;
    log(`  이용권 추가 대상: ${memberName || '(이름 미확인)'} (mb_no=${mbNo}, ${phoneFormatted})`);

    // [4단계] 자유석 선택 + 이용권 목록 로드
    await selectSeatTypeAndLoad(page);

    // [5단계] 이용권 추가 (+버튼 count회)
    await addTicket(page, TICKET_NAME, COUNT);

    // [5.5단계] 할인 추가 (--discount 플래그 시)
    if (DISCOUNT) {
      await applyDiscount(page);
    }

    // [6단계] 주문정보 확인
    await verifyOrderSummary(page, TICKET_NAME);

    // [6.5단계] 주문 메모 입력 (--discount 또는 --reason 제공 시)
    if (DISCOUNT || REASON_RAW) {
      await fillOrderMemo(page, REASON);
    }

    // [7단계] 현금 선택
    await selectCash(page);

    // [8단계] 결제하기 클릭
    await clickMainPayButton(page);

    // [9단계] 팝업 처리
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

main().catch(err => {
  log(`❌ 치명 오류: ${err.message}`);
  fail(err.message);
});
