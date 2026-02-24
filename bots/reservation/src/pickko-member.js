#!/usr/bin/env node

/**
 * pickko-member.js — 신규 회원 가입 CLI 래퍼
 *
 * 사용법:
 *   node src/pickko-member.js \
 *     --phone=01012345678 \
 *     --name=홍길동 \
 *     [--birth=2000-01-01]  (선택, 미입력 시 오늘 날짜로 대체)
 *
 * 출력 (stdout JSON):
 *   { success: true,  isNew: true,  message: "신규 회원 등록 완료: ..." }
 *   { success: true,  isNew: false, message: "기존 회원입니다: ..." }
 *   { success: false, message: "오류 내용" }
 */

const puppeteer = require('puppeteer');
const { parseArgs } = require('../lib/args');
const { delay, log } = require('../lib/utils');
const { loadSecrets } = require('../lib/secrets');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../lib/browser');
const { loginToPickko } = require('../lib/pickko');

const SECRETS = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;
const ARGS = parseArgs(process.argv);

function outputResult(result) {
  process.stdout.write(JSON.stringify(result) + '\n');
}

function fail(message) {
  outputResult({ success: false, message });
  process.exit(1);
}

// ── 입력 검증 ──
if (!ARGS.phone || !ARGS.name) {
  fail('필수 인자 누락: --phone, --name\n사용법: node pickko-member.js --phone=01000000000 --name=이름');
}

const PHONE_RAW = ARGS.phone.replace(/\D/g, '');
if (!/^\d{10,11}$/.test(PHONE_RAW)) {
  fail(`전화번호 형식 오류: ${ARGS.phone} (10~11자리 숫자여야 함)`);
}

const CUSTOMER_NAME = ARGS.name.replace(/대리예약.*/, '').trim().slice(0, 20) || '고객';
const BIRTH_DATE = ARGS.birth || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

// ── 기존 회원 검색 (예약 등록 페이지의 회원 picker 활용) ──
async function findMember(page, phoneNoHyphen) {
  log(`\n[회원 검색] 전화번호: ${phoneNoHyphen}`);

  await page.goto('https://pickkoadmin.com/study/write.html', {
    waitUntil: 'domcontentloaded'
  });
  await delay(3000);

  // 전화번호 입력
  await page.evaluate((phone) => {
    const inputs = document.querySelectorAll('input[type="text"]');
    let target = null;
    for (const inp of inputs) {
      if (inp.placeholder && (inp.placeholder.includes('이름') || inp.placeholder.includes('검색'))) {
        target = inp;
        break;
      }
    }
    if (!target && inputs.length > 0) target = inputs[inputs.length - 1];
    if (target) {
      target.value = phone;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    }
  }, phoneNoHyphen);
  await delay(3000);

  // 회원 선택 버튼 클릭 → 모달 열기
  try {
    await page.click('a#mb_select_btn');
  } catch (e) {
    log(`⚠️ mb_select_btn 클릭 실패, 대체 시도: ${e.message}`);
    await page.evaluate(() => {
      const links = document.querySelectorAll('a.btn_box');
      for (const a of links) {
        if (a.textContent.includes('회원 선택')) { a.click(); return; }
      }
    });
  }
  await delay(2000);

  // 모달에서 회원 목록 확인
  const found = await page.evaluate((phoneSuffix) => {
    const members = document.querySelectorAll('a.mb_select');
    if (members.length === 0) return { exists: false };
    // 전화번호 suffix로 재확인
    for (const mb of members) {
      const row = mb.closest('tr');
      if (row && row.textContent.replace(/\s+/g, '').includes(phoneSuffix)) {
        return { exists: true };
      }
    }
    // 검색 결과가 있으면 해당 번호의 고객 존재
    return { exists: true };
  }, PHONE_RAW.slice(-8));

  // 모달 닫기
  try { await page.keyboard.press('Escape'); } catch (e) {}
  await delay(500);

  return found;
}

// ── 신규 회원 등록 (pickko-accurate.js의 registerNewMember 로직 재활용) ──
async function registerNewMember(page, phoneNoHyphen, customerName, birthDate) {
  log(`\n[회원 등록] ${customerName} (${phoneNoHyphen})`);

  const phone1 = phoneNoHyphen.slice(0, 3);
  const phone2 = phoneNoHyphen.slice(3, 7);
  const phone3 = phoneNoHyphen.slice(7);
  const pin = phoneNoHyphen.slice(3); // 010 제외 8자리

  await page.goto('https://pickkoadmin.com/member/write.html', {
    waitUntil: 'domcontentloaded'
  });
  await delay(2000);

  // 이름 입력
  const nameInput = await page.$('input[name="mb_name"]');
  if (nameInput) {
    await nameInput.click({ clickCount: 3 });
    await nameInput.type(customerName, { delay: 50 });
  }
  await delay(300);

  // 전화번호 (3분할)
  const ph1El = await page.$('#mb_phone1');
  const ph2El = await page.$('#mb_phone2');
  const ph3El = await page.$('#mb_phone3');
  if (ph1El) { await ph1El.click({ clickCount: 3 }); await ph1El.type(phone1, { delay: 50 }); }
  await delay(200);
  if (ph2El) { await ph2El.click({ clickCount: 3 }); await ph2El.type(phone2, { delay: 50 }); }
  await delay(200);
  if (ph3El) { await ph3El.click({ clickCount: 3 }); await ph3El.type(phone3, { delay: 50 }); }
  await delay(300);

  // PIN (010 제외 8자리)
  const codeEl = await page.$('#mb_code');
  if (codeEl) {
    await codeEl.click({ clickCount: 3 });
    await codeEl.type(pin, { delay: 50 });
  }
  await delay(300);

  // 생년월일 (datepicker API 또는 직접 입력)
  await page.evaluate((bd) => {
    const birthInput = document.querySelector('#mb_birth');
    if (!birthInput) return;
    birthInput.removeAttribute('readonly');
    if (typeof jQuery !== 'undefined' && jQuery(birthInput).data('datepicker')) {
      jQuery(birthInput).datepicker('setDate', new Date(bd));
    } else {
      birthInput.value = bd;
      birthInput.dispatchEvent(new Event('input', { bubbles: true }));
      birthInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, birthDate);
  await delay(300);

  log(`✅ 회원정보 입력: ${customerName} / ${phone1}-${phone2}-${phone3} / PIN: ${pin}`);

  // form.submit() (JS 생년월일 검증 우회)
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {}),
    page.evaluate(() => {
      const form = document.querySelector('form#memberFrom, form');
      if (form) HTMLFormElement.prototype.submit.call(form);
    })
  ]);
  await delay(1000);

  const registerUrl = page.url();
  if (registerUrl.includes('/member/view/')) {
    log(`✅ 신규 회원 등록 성공: ${customerName} (${phoneNoHyphen}) → ${registerUrl}`);
    return true;
  } else {
    throw new Error(`회원 등록 실패: URL이 /member/view/ 아님 (${registerUrl})`);
  }
}

// ── main ──
async function main() {
  log(`\n🚀 픽코 회원 가입: ${CUSTOMER_NAME} (${PHONE_RAW})`);

  let browser;
  try {
    browser = await puppeteer.launch(getPickkoLaunchOptions());
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, log);

    // 1. 로그인
    log('\n[1단계] 픽코 로그인');
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log(`✅ 로그인 완료`);

    // 2. 기존 회원 검색
    log('\n[2단계] 기존 회원 검색');
    const existing = await findMember(page, PHONE_RAW);

    if (existing.exists) {
      log(`✅ 기존 회원 확인됨: ${CUSTOMER_NAME} (${PHONE_RAW})`);
      outputResult({
        success: true,
        isNew: false,
        message: `기존 회원입니다: ${CUSTOMER_NAME} (${PHONE_RAW.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3')})`
      });
      return;
    }

    log(`ℹ️ 미등록 회원 → 신규 등록 진행`);

    // 3. 신규 회원 등록
    log('\n[3단계] 신규 회원 등록');
    await registerNewMember(page, PHONE_RAW, CUSTOMER_NAME, BIRTH_DATE);

    outputResult({
      success: true,
      isNew: true,
      message: `신규 회원 등록 완료: ${CUSTOMER_NAME} (${PHONE_RAW.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3')})`
    });

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
