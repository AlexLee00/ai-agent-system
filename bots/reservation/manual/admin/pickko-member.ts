#!/usr/bin/env node
/// <reference lib="dom" />

/**
 * pickko-member.js — 신규 회원 가입 CLI 래퍼
 *
 * 사용법:
 *   node src/pickko-member.js \
 *     --phone=01012345678 \
 *     --name=홍길동 \
 *     [--birth=2000-01-01]
 */

const puppeteer = require('puppeteer');
const { parseArgs } = require('../../lib/args');
const { delay, log } = require('../../lib/utils');
const { loadSecrets } = require('../../lib/secrets');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../../lib/browser');
const { loginToPickko, findPickkoMember } = require('../../lib/pickko');
const { outputResult, fail } = require('../../lib/cli');
const { maskPhone, maskName } = require('../../lib/formatting');

declare const jQuery: any;

const SECRETS = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;
const ARGS = parseArgs(process.argv);

if (!ARGS.phone || !ARGS.name) {
  fail('필수 인자 누락: --phone, --name\n사용법: node pickko-member.js --phone=01000000000 --name=이름');
}

const PHONE_RAW = ARGS.phone.replace(/\D/g, '');
if (!/^\d{10,11}$/.test(PHONE_RAW)) {
  fail(`전화번호 형식 오류: ${ARGS.phone} (10~11자리 숫자여야 함)`);
}

const CUSTOMER_NAME = ARGS.name.replace(/대리예약.*/, '').trim().slice(0, 20) || '고객';
const BIRTH_DATE = ARGS.birth || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

async function findMember(page: any, phoneNoHyphen: string): Promise<{ exists: boolean }> {
  log(`\n[회원 검색] 전화번호: ${maskPhone(phoneNoHyphen)}`);
  const result = await findPickkoMember(page, phoneNoHyphen, delay);
  log(`  검색 결과: ${JSON.stringify(result)}`);
  return { exists: result.found };
}

async function registerNewMember(
  page: any,
  phoneNoHyphen: string,
  customerName: string,
  birthDate: string,
) {
  log(`\n[회원 등록] ${maskName(customerName)} (${maskPhone(phoneNoHyphen)})`);

  const phone1 = phoneNoHyphen.slice(0, 3);
  const phone2 = phoneNoHyphen.slice(3, 7);
  const phone3 = phoneNoHyphen.slice(7);
  const pin = phoneNoHyphen.slice(3);

  await page.goto('https://pickkoadmin.com/member/write.html', {
    waitUntil: 'domcontentloaded',
  });
  await delay(2000);

  const nameInput = await page.$('input[name="mb_name"]');
  if (nameInput) {
    await nameInput.click({ clickCount: 3 });
    await nameInput.type(customerName, { delay: 50 });
  }
  await delay(300);

  const ph1El = await page.$('#mb_phone1');
  const ph2El = await page.$('#mb_phone2');
  const ph3El = await page.$('#mb_phone3');
  if (ph1El) { await ph1El.click({ clickCount: 3 }); await ph1El.type(phone1, { delay: 50 }); }
  await delay(200);
  if (ph2El) { await ph2El.click({ clickCount: 3 }); await ph2El.type(phone2, { delay: 50 }); }
  await delay(200);
  if (ph3El) { await ph3El.click({ clickCount: 3 }); await ph3El.type(phone3, { delay: 50 }); }
  await delay(300);

  const codeEl = await page.$('#mb_code');
  if (codeEl) {
    await codeEl.click({ clickCount: 3 });
    await codeEl.type(pin, { delay: 50 });
  }
  await delay(300);

  await page.evaluate((bd: string) => {
    const birthInput = document.querySelector('#mb_birth') as HTMLInputElement | null;
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

  log(`✅ 회원정보 입력: ${maskName(customerName)} / ${maskPhone(phoneNoHyphen)}`);

  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {}),
    page.evaluate(() => {
      const form = document.querySelector('form#memberFrom, form');
      if (form) HTMLFormElement.prototype.submit.call(form);
    }),
  ]);
  await delay(1000);

  const registerUrl = page.url();
  if (registerUrl.includes('/member/view/')) {
    log(`✅ 신규 회원 등록 성공: ${maskName(customerName)} (${maskPhone(phoneNoHyphen)}) → ${registerUrl}`);
    return true;
  }
  throw new Error(`회원 등록 실패: URL이 /member/view/ 아님 (${registerUrl})`);
}

async function main() {
  log(`\n🚀 픽코 회원 가입: ${CUSTOMER_NAME} (${PHONE_RAW})`);

  let browser;
  try {
    browser = await puppeteer.launch(getPickkoLaunchOptions());
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, log);

    log('\n[1단계] 픽코 로그인');
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log('✅ 로그인 완료');

    log('\n[2단계] 기존 회원 검색');
    const existing = await findMember(page, PHONE_RAW);

    if (existing.exists) {
      log(`✅ 기존 회원 확인됨: ${CUSTOMER_NAME} (${PHONE_RAW})`);
      outputResult({
        success: true,
        isNew: false,
        message: `기존 회원입니다: ${CUSTOMER_NAME} (${PHONE_RAW.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3')})`,
      });
      return;
    }

    log('ℹ️ 미등록 회원 → 신규 등록 진행');

    log('\n[3단계] 신규 회원 등록');
    await registerNewMember(page, PHONE_RAW, CUSTOMER_NAME, BIRTH_DATE);

    outputResult({
      success: true,
      isNew: true,
      message: `신규 회원 등록 완료: ${CUSTOMER_NAME} (${PHONE_RAW.replace(/(\d{3})(\d{4})(\d{4})/, '$1-$2-$3')})`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log(`❌ 오류: ${message}`);
    fail(message);
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_e: unknown) {}
    }
  }
}

module.exports = {
  findMember,
  registerNewMember,
  main,
};

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  log(`❌ 치명 오류: ${message}`);
  fail(message);
});
