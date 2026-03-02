#!/usr/bin/env node

/**
 * pickko-pay-scan.js — 결제대기 예약 일괄 결제완료 처리
 *
 * 픽코 어드민 스터디룸 목록에서 sd_step=1(결제대기) 필터로 검색 후
 * 해당 건 전체를 0원 현금 결제완료로 처리한다.
 *
 * 사용법:
 *   node src/pickko-pay-scan.js                        # 전체 결제대기 처리
 *   node src/pickko-pay-scan.js --phone=01037410771    # 특정 전화번호만
 *   node src/pickko-pay-scan.js --dry-run              # 조회만 (결제 안 함)
 *
 * 출력:
 *   { success: true, processed: N, skipped: N, failed: N, items: [...] }
 */

const puppeteer = require('puppeteer');
const { delay, log } = require('../lib/utils');
const { loadSecrets } = require('../lib/secrets');
const { parseArgs } = require('../lib/args');
const { formatPhone } = require('../lib/formatting');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../lib/browser');
const { loginToPickko } = require('../lib/pickko');

const SECRETS   = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;

const ARGS     = parseArgs(process.argv);
const PHONE_RAW = (ARGS.phone || '').replace(/\D/g, '');
const PHONE_FMT = PHONE_RAW ? formatPhone(PHONE_RAW) : '';
const DRY_RUN   = !!ARGS['dry-run'];

if (DRY_RUN) log('🔍 DRY-RUN 모드: 조회만 실행 (결제 처리 안 함)');
if (PHONE_FMT) log(`📞 전화번호 필터: ${PHONE_FMT}`);

// ======================== 결제 유틸 ========================
const norm = (s) => (s ?? '').replace(/[\s,]/g, '').trim();

async function setTopPriceZero(page) {
  const inp = await page.$('#od_add_item_price');
  if (!inp) return false;
  await inp.click({ clickCount: 3 });
  await delay(120);
  try { await page.keyboard.press('Meta+A'); } catch (e) {}
  for (let k = 0; k < 8; k++) { await page.keyboard.press('Backspace'); await delay(40); }
  await delay(80);
  await page.keyboard.type('0', { delay: 80 });
  await delay(150);
  await page.mouse.click(20, 20);
  return true;
}

async function setMemo(page) {
  try {
    await page.$eval('#od_memo', (el) => {
      el.value = '네이버예약 결제';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    return true;
  } catch (e) { return false; }
}

async function clickCash(page) {
  try {
    await page.waitForSelector('label[for="pay_type1_2"]', { timeout: 5000 });
    const lbl = await page.$('label[for="pay_type1_2"]');
    if (!lbl) return false;
    await page.evaluate(() => document.querySelector('label[for="pay_type1_2"]')?.scrollIntoView({ block: 'center' }));
    await delay(200);
    const box = await lbl.boundingBox();
    if (!box) return false;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await delay(150);
    return await page.evaluate(() => document.querySelector('#pay_type1_2')?.checked ?? false);
  } catch (e) { return false; }
}

async function waitTotalZero(page) {
  for (let i = 0; i < 10; i++) {
    await delay(250);
    const v = await page.evaluate(() => (document.querySelector('#od_total_price3')?.textContent || '').trim());
    if (norm(v) === '0') return true;
  }
  return false;
}

async function processPayment(page) {
  // 결제하기 버튼 클릭
  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"]'));
    for (const b of btns) {
      if ((b.innerText || b.value || b.textContent || '').trim() === '결제하기') { b.click(); return true; }
    }
    return false;
  });
  if (!clicked) return { success: false, reason: '결제하기 버튼 없음' };
  await delay(1200);

  // 결제 모달 입력
  await setTopPriceZero(page); await delay(250);
  await setMemo(page);         await delay(250);
  await clickCash(page);       await delay(250);
  const totalOk = await waitTotalZero(page);
  if (!totalOk) return { success: false, reason: '총액 0 안정화 실패' };

  // 제출
  let submitted = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await page.waitForSelector('#pay_order', { timeout: 5000 });
      await page.evaluate(() => document.querySelector('#pay_order')?.scrollIntoView({ block: 'center' }));
      await delay(150);
      const box = await page.$('#pay_order').then(h => h?.boundingBox());
      if (box) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        submitted = true;
      }
    } catch (e) {}
    await delay(600);
    const closed = await page.evaluate(() => !document.querySelector('#order_write'));
    if (closed) break;
  }

  // 팝업 확인
  await delay(800);
  await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"]'));
    const btn = btns.find(b => ['확인', 'OK'].includes((b.textContent || b.value || '').trim()));
    if (btn) btn.click();
  });
  await delay(500);

  const hasError = await page.evaluate(() => (document.body?.innerText || '').includes('에러'));
  return { success: submitted && !hasError, reason: submitted ? null : '제출 실패' };
}

// ======================== 메인 ========================
async function run() {
  let browser;
  const results = { processed: 0, skipped: 0, failed: 0, items: [] };

  try {
    browser = await puppeteer.launch(getPickkoLaunchOptions());
    const pages = await browser.pages();
    const page  = pages[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, log);

    // [1단계] 로그인
    log('\n[1단계] 픽코 로그인');
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log('✅ 로그인 완료');

    // [2단계] study/index.html 이동
    log('\n[2단계] study/index.html 이동');
    await page.goto('https://pickkoadmin.com/study/index.html', { waitUntil: 'networkidle2', timeout: 30000 });
    await delay(1500);

    // [3단계] 결제대기 필터 + 전화번호 설정
    log('\n[3단계] 결제대기 필터 설정');
    await page.evaluate((phoneFmt) => {
      // 결제대기 라디오 선택
      const radio = document.querySelector('#sd_step1');
      if (radio) { radio.checked = true; radio.click(); }
      // 전화번호 (있는 경우)
      if (phoneFmt) {
        const el = document.querySelector('input[name="mb_phone"]');
        if (el) { el.value = phoneFmt; el.dispatchEvent(new Event('input', { bubbles: true })); }
      }
    }, PHONE_FMT);
    await delay(300);

    // [4단계] 검색 실행
    log('\n[4단계] 검색 실행');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null),
      page.evaluate(() => document.querySelector('input[type="submit"].btn_box')?.click()),
    ]);
    await delay(1500);

    // [5단계] 결과 목록에서 view 링크 전체 수집
    log('\n[5단계] 결제대기 목록 수집');
    const items = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('tbody tr'));
      return rows.flatMap(tr => {
        const a = tr.querySelector('a[href*="/study/view/"]');
        if (!a) return [];
        const text = (tr.textContent || '').replace(/\s+/g, ' ').trim();
        return [{ href: a.href, text: text.substring(0, 100) }];
      });
    });

    log(`📋 결제대기 ${items.length}건 발견`);
    if (items.length === 0) {
      log('✅ 결제대기 건 없음');
      process.stdout.write(JSON.stringify({ success: true, ...results }) + '\n');
      await browser.close();
      return;
    }

    items.forEach((it, i) => log(`   ${i + 1}. ${it.text}`));

    if (DRY_RUN) {
      log('\n🔍 DRY-RUN: 결제 처리 생략');
      process.stdout.write(JSON.stringify({ success: true, dryRun: true, found: items.length, items: items.map(i => i.text) }) + '\n');
      await browser.close();
      return;
    }

    // [6단계] 각 건 결제 처리
    log('\n[6단계] 결제 처리 시작');
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      log(`\n── [${idx + 1}/${items.length}] ${item.text.substring(0, 60)}`);
      log(`   URL: ${item.href}`);

      await page.goto(item.href, { waitUntil: 'networkidle2', timeout: 20000 });
      await delay(1500);

      const status = await page.evaluate(() => {
        const body = (document.body?.innerText || '').replace(/\s+/g, ' ');
        return {
          isCompleted: body.includes('결제완료'),
          isPending:   body.includes('결제대기'),
        };
      });

      if (status.isCompleted && !status.isPending) {
        log('   ℹ️ 이미 결제완료 → 스킵');
        results.skipped++;
        results.items.push({ text: item.text, result: 'skipped' });
        continue;
      }

      const payResult = await processPayment(page);
      if (payResult.success) {
        log('   ✅ 결제완료 처리 성공');
        results.processed++;
        results.items.push({ text: item.text, result: 'processed' });
      } else {
        log(`   ❌ 결제 실패: ${payResult.reason}`);
        results.failed++;
        results.items.push({ text: item.text, result: 'failed', reason: payResult.reason });
      }

      await delay(1000);
    }

    log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    log(`✅ 완료: 처리=${results.processed} / 스킵=${results.skipped} / 실패=${results.failed}`);
    process.stdout.write(JSON.stringify({ success: true, ...results }) + '\n');

  } catch (err) {
    log(`❌ 오류: ${err.message}`);
    process.stdout.write(JSON.stringify({ success: false, message: err.message, ...results }) + '\n');
    process.exitCode = 1;
  } finally {
    try { if (browser) await browser.close(); } catch (e) {}
  }
}

run();
