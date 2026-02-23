#!/usr/bin/env node
/**
 * 신규 회원 자동 등록 테스트 스크립트
 * 실행할 때마다 카운터가 1씩 증가
 *
 * 테스트 데이터 패턴:
 *   counter N (1부터 시작)
 *   - 이름     : 테스트-001, 테스트-002, ...
 *   - 전화     : 000-0000-0002, 000-0000-0003, ...
 *   - PIN      : 00000002, 00000003, ...
 *   - 생년월일 : 오늘 날짜 (YYYY-MM-DD)
 *
 * ✅ form.submit() 직접 호출로 JS 생년월일 검증 우회 확인됨
 */

const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');

const PICKKO_ID = 'a2643301450';
const PICKKO_PW = 'lsh120920!';
const COUNTER_FILE = path.join(__dirname, '.test-counter');

const delay = (ms) => new Promise(r => setTimeout(r, ms));

function log(msg) {
  const ts = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
  console.log(`[${ts}] ${msg}`);
}

// ── 카운터 읽기 / 증가 ──────────────────────────────
function readCounter() {
  try { return parseInt(fs.readFileSync(COUNTER_FILE, 'utf-8').trim(), 10) || 0; }
  catch { return 0; }
}
function saveCounter(n) {
  fs.writeFileSync(COUNTER_FILE, String(n));
}

// ── 테스트 데이터 생성 ───────────────────────────────
function buildTestData(counter) {
  const n = counter; // 이름용
  const m = counter + 1; // 전화/PIN용 (0002부터 시작)

  const name      = `테스트-${String(n).padStart(3, '0')}`;
  const phone1    = '000';
  const phone2    = '0000';
  const phone3    = String(m).padStart(4, '0');
  const phoneRaw  = `${phone1}${phone2}${phone3}`;  // 11자리
  const pin       = String(m).padStart(8, '0');
  const birthDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }); // YYYY-MM-DD

  return { name, phone1, phone2, phone3, phoneRaw, pin, birthDate };
}

// ── 신규 회원 등록 ───────────────────────────────────
async function registerMember(page, data) {
  log(`\n📋 등록할 회원 정보:`);
  log(`   이름     : ${data.name}`);
  log(`   전화     : ${data.phone1}-${data.phone2}-${data.phone3}`);
  log(`   PIN      : ${data.pin}`);
  log(`   생년월일 : ${data.birthDate}`);

  await page.goto('https://pickkoadmin.com/member/write.html', { waitUntil: 'domcontentloaded' });
  await delay(2000);

  // 1. 이름 (page.type 으로 실제 입력 시뮬레이션)
  log('▶ 이름 입력: ' + data.name);
  const nameInput = await page.$('input[name="mb_name"]');
  if (nameInput) {
    await nameInput.click({ clickCount: 3 });
    await nameInput.type(data.name, { delay: 80 });
  }
  await delay(400);

  // 2. 전화번호 (3분할)
  log(`▶ 전화번호 입력: ${data.phone1} / ${data.phone2} / ${data.phone3}`);
  const ph1 = await page.$('#mb_phone1');
  const ph2 = await page.$('#mb_phone2');
  const ph3 = await page.$('#mb_phone3');
  if (ph1) { await ph1.click({ clickCount: 3 }); await ph1.type(data.phone1, { delay: 80 }); }
  await delay(200);
  if (ph2) { await ph2.click({ clickCount: 3 }); await ph2.type(data.phone2, { delay: 80 }); }
  await delay(200);
  if (ph3) { await ph3.click({ clickCount: 3 }); await ph3.type(data.phone3, { delay: 80 }); }
  await delay(400);

  // 3. PIN
  log(`▶ PIN 입력: ${data.pin}`);
  const codeInput = await page.$('#mb_code');
  if (codeInput) {
    await codeInput.click({ clickCount: 3 });
    await codeInput.type(data.pin, { delay: 80 });
  }
  await delay(400);

  // 4. 생년월일 (datepicker API로 설정 + readonly 해제)
  log(`▶ 생년월일 입력: ${data.birthDate}`);
  await page.evaluate((birthDate) => {
    const birthInput = document.querySelector('#mb_birth');
    if (!birthInput) return;
    birthInput.removeAttribute('readonly');
    // jQuery datepicker API 시도
    if (typeof jQuery !== 'undefined' && jQuery(birthInput).data('datepicker')) {
      jQuery(birthInput).datepicker('setDate', new Date(birthDate));
    } else {
      birthInput.value = birthDate;
      birthInput.dispatchEvent(new Event('input', { bubbles: true }));
      birthInput.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, data.birthDate);
  await delay(400);

  // 5. form.submit() 직접 호출 (JS 생년월일 검증 우회)
  log('▶ form.submit() 직접 호출');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {}),
    page.evaluate(() => {
      const form = document.querySelector('form#memberFrom, form');
      if (form) HTMLFormElement.prototype.submit.call(form);
    })
  ]);
  await delay(1000);

  const finalUrl = page.url();
  log(`✅ 제출 완료, URL: ${finalUrl}`);
  return finalUrl;
}

// ── 메인 ────────────────────────────────────────────
async function main() {
  const prev = readCounter();
  const counter = prev + 1;
  const data = buildTestData(counter);

  log(`\n🧪 신규 회원 등록 테스트 (회차: ${counter})`);
  log('='.repeat(50));

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null, // 창 크기 = 뷰포트 (짤림 방지)
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-position=0,25',  // 주 모니터 고정 (메뉴바 25px 아래)
        '--window-size=2294,1380', // 맥북 해상도 기준
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TabDiscarding,Translate,BackForwardCache'
      ]
    });

    const pages = await browser.pages();
    const page = pages.length > 0 ? pages[0] : await browser.newPage();

    // 팝업 자동 확인
    page.on('dialog', async (dialog) => {
      log(`🧾 팝업: "${dialog.message()}"`);
      await dialog.accept();
    });

    // 1. 로그인
    log('\n[1단계] 픽코 로그인');
    await page.goto('https://pickkoadmin.com/manager/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate((id, pw) => {
      document.getElementById('mn_id').value = id;
      document.getElementById('mn_pw').value = pw;
      document.getElementById('loginButton').click();
    }, PICKKO_ID, PICKKO_PW);
    await delay(3000);
    log('✅ 로그인 완료');

    // 2. 회원 등록
    log('\n[2단계] 신규 회원 등록');
    const resultUrl = await registerMember(page, data);

    // 3. 결과 확인 (URL에 /member/view/ 포함되면 성공)
    if (resultUrl.includes('/member/view/')) {
      log(`\n✅ 회원 등록 성공! → ${resultUrl}`);
      saveCounter(counter);
      log(`💾 카운터 저장: ${counter} → 다음 테스트는 ${counter + 1}회차`);
    } else {
      log(`\n⚠️  등록 실패 (URL 변경 없음: ${resultUrl})`);
      log(`   브라우저에서 직접 확인해주세요.`);
    }

    log('\n🔍 브라우저를 확인하세요. (15초 후 자동 종료)');
    await delay(15000);

  } catch (err) {
    log(`❌ 오류: ${err.message}`);
    console.error(err);
    process.exit(1);
  } finally {
    if (browser) await browser.close();
  }
}

main();
