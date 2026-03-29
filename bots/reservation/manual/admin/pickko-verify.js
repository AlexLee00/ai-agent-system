#!/usr/bin/env node

/**
 * pickko-verify.js — 미검증 예약 검증 스크립트
 *
 * 대상:
 *   1. reservation/naver-seen.json 의 pending/failed 항목
 *   2. reservation/naver-seen.json 의 completed 이지만 pickkoStatus가 verified/manual 아닌 항목
 *   3. ~/.openclaw/workspace/naver-seen.json 의 pending 항목 (구 OpenClaw 파일)
 *
 * 동작:
 *   - 픽코에서 전화번호+날짜 검색
 *   - 이미 등록됨  → completed/verified 처리
 *   - 미등록       → pickko-accurate.js 자동 실행
 *
 * 사용법:
 *   node pickko-verify.js            (전체 검증)
 *   node pickko-verify.js --dry-run  (검색만, 등록 안 함)
 */

const puppeteer = require('puppeteer');
const { spawn }  = require('child_process');
const path = require('path');
const { delay, log } = require('../../lib/utils');
const { loadSecrets } = require('../../lib/secrets');
const { toKoreanTime, pickkoEndTime, formatPhone, maskPhone } = require('../../lib/formatting');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../../lib/browser');
const { loginToPickko, fetchPickkoEntries } = require('../../lib/pickko');
const {
  getPendingReservations,
  getUnverifiedCompletedReservations,
  addReservation,
  updateReservation,
  getReservation,
  markSeen,
} = require('../../lib/db');
const { IS_OPS } = require('../../../../packages/core/lib/env');

// ──────────────────────────────────────────────
// 설정
// ──────────────────────────────────────────────
const SECRETS    = loadSecrets();
const PICKKO_ID  = SECRETS.pickko_id;
const PICKKO_PW  = SECRETS.pickko_pw;
const MODE       = IS_OPS ? 'ops' : 'dev';
const DRY_RUN    = process.argv.includes('--dry-run');

// ──────────────────────────────────────────────
// pending/failed/미검증completed 항목 수집 (DB 기반)
// ──────────────────────────────────────────────

// 픽코 검증이 필요한 항목인지 판별
// - pending/failed: 아직 픽코 등록 여부 확인 전
// - completed + pickkoStatus가 verified/manual 아닌 것(paid/auto 등): 등록은 됐지만 검증 미완
function needsVerify(entry) {
  if (entry.status === 'pending' || entry.status === 'failed') return true;
  if (entry.status === 'completed') {
    const ps = entry.pickkoStatus;
    return ps !== 'verified' && ps !== 'manual';
  }
  return false;
}

async function collectTargets() {
  // DB에서 pending/processing/failed + completed 미검증 항목 수집
  const pending    = await getPendingReservations();            // status IN ('pending','processing','failed')
  const unverified = await getUnverifiedCompletedReservations(); // completed이지만 pickkoStatus 미검증

  const targets = [];
  const seen = new Set();

  for (const entry of [...pending, ...unverified]) {
    if (!needsVerify(entry)) continue;
    const ck = entry.compositeKey || entry.id;
    if (!seen.has(ck)) {
      seen.add(ck);
      targets.push({ source: 'db', id: entry.id, entry });
    }
  }

  return targets;
}

// ──────────────────────────────────────────────
// 픽코 검색 (pickko-cancel.js Stage 2~4 동일)
// ──────────────────────────────────────────────
async function searchPickko(page, entry) {
  const phone       = formatPhone(entry.phone || entry.phoneRaw || '');
  const date        = entry.date;
  const startKorean = toKoreanTime(entry.start);
  const endKorean   = toKoreanTime(pickkoEndTime(entry.end));
  const phoneSuffix = phone.replace(/\D/g,'').slice(-8);

  log(`  🔍 검색: ${maskPhone(phone)} | ${date} | ${entry.start}~${entry.end} | ${entry.room}룸`);

  // 목록 페이지 이동
  await page.goto('https://pickkoadmin.com/study/index.html', { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(1500);

  // 전화번호 입력
  await page.$eval('input[name="mb_phone"]', (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, phone);

  // 날짜 입력 (시작/종료 동일)
  for (const name of ['sd_start_up', 'sd_start_dw']) {
    await page.evaluate((nm, d) => {
      const el = document.querySelector(`input[name="${nm}"]`);
      if (!el) return;
      el.removeAttribute('readonly');
      el.value = d;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      try { if (window.jQuery?.fn.datepicker) window.jQuery(el).datepicker('setDate', new Date(d)); } catch(e){}
    }, name, date);
  }

  await delay(300);

  // 검색 (page.click → evaluate: Runtime.callFunctionOn 타임아웃 방지)
  await Promise.all([
    page.evaluate(() => {
      const btn = document.querySelector('input[type="submit"].btn_box');
      if (btn) btn.click();
    }),
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null)
  ]);
  await delay(1500);

  // 결과 파싱 (1순위: 시작+종료 / 2순위: 시작만 / 3순위: 전화번호 뒤 8자리)
  const viewHref = await page.evaluate((sk, ek, ps) => {
    const clean = s => (s ?? '').replace(/\s+/g, ' ').trim();
    const trs   = Array.from(document.querySelectorAll('tbody tr'));
    for (const tr of trs) {
      const t = clean(tr.textContent);
      if (t.includes(sk) && t.includes(ek)) { const a = tr.querySelector('a[href*="/study/view/"]'); if (a) return a.href; }
    }
    for (const tr of trs) {
      const t = clean(tr.textContent);
      if (t.includes(sk)) { const a = tr.querySelector('a[href*="/study/view/"]'); if (a) return a.href; }
    }
    for (const tr of trs) {
      const t = clean(tr.textContent);
      if (t.includes(ps)) { const a = tr.querySelector('a[href*="/study/view/"]'); if (a) return a.href; }
    }
    return null;
  }, startKorean, endKorean, phoneSuffix);

  return viewHref;
}

// ──────────────────────────────────────────────
// 상태 업데이트 (DB 기반)
// ──────────────────────────────────────────────
async function markCompleted(source, id, entry) {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  const existing = await getReservation(id);
  if (existing) {
    await updateReservation(id, {
      status:          'completed',
      pickkoStatus:    'verified',
      errorReason:     null,
      pickkoStartTime: now,
    });
  } else {
    await addReservation(id, {
      compositeKey:    entry.compositeKey || `${(entry.phoneRaw||entry.phone||'').replace(/\D/g,'')}`,
      name:            entry.name || entry.raw?.name || null,
      phone:           entry.phone,
      phoneRaw:        entry.phoneRaw || (entry.phone||'').replace(/\D/g,''),
      date:            entry.date,
      start:           entry.start,
      end:             entry.end,
      room:            entry.room,
      detectedAt:      entry.detectedAt,
      status:          'completed',
      pickkoStatus:    'verified',
      retries:         entry.retries || 0,
      pickkoStartTime: now,
    });
  }
  await markSeen(id);
}

// ──────────────────────────────────────────────
// pickko-accurate.js 실행
// ──────────────────────────────────────────────
function runPickko(entry) {
  return new Promise(resolve => {
    const phone = (entry.phoneRaw || entry.phone || '').replace(/\D/g,'');
    const args  = [
      path.join(__dirname, '../reservation/pickko-accurate.js'),
      `--phone=${phone}`,
      `--date=${entry.date}`,
      `--start=${entry.start}`,
      `--end=${entry.end}`,
      `--room=${entry.room}`,
      `--name=${entry.raw?.name || '고객'}`
    ];
    log(`  🤖 픽코 등록 실행: ${maskPhone(phone)} ${entry.date} ${entry.start}~${entry.end} ${entry.room}룸`);
    const child = spawn('node', args, { cwd: path.join(__dirname, '../reservation'), stdio: 'inherit' });
    child.on('close', code => {
      log(`  🤖 픽코 완료 (exit: ${code})`);
      resolve(code);
    });
  });
}

// ──────────────────────────────────────────────
// 메인
// ──────────────────────────────────────────────
async function main() {
  const targets = await collectTargets();

  if (targets.length === 0) {
    log('✅ 검증 대상 없음');
    return;
  }

  log(`\n📋 검증 대상: ${targets.length}건`);
  for (const { source, id, entry } of targets) {
    log(`  [${source}] ${id} | ${maskPhone(entry.phone)} | ${entry.date} ${entry.start}~${entry.end} | ${entry.room}룸 | status=${entry.status} | retries=${entry.retries||0}`);
  }

  if (DRY_RUN) {
    log('\n🔍 --dry-run 모드: 픽코 로그인 없이 목록만 출력');
    return;
  }

  // 픽코 브라우저 시작
  log('\n🚀 픽코 브라우저 시작...');
  let browser;
  try {
    browser = await puppeteer.launch(getPickkoLaunchOptions());

    const pages  = await browser.pages();
    const page   = pages[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, log);

    // 로그인
    log('\n[1단계] 픽코 로그인 + 일괄 조회');
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log(`✅ 로그인 완료: ${page.url()}`);

    // 날짜별 그룹화 → 일괄 조회
    const dateGroups = {};
    for (const item of targets) {
      const d = item.entry.date;
      if (!dateGroups[d]) dateGroups[d] = [];
      dateGroups[d].push(item);
    }

    const pickkoByDate = {};
    const uniqueDates = Object.keys(dateGroups);
    log(`\n[2단계] 픽코 일괄 조회: ${uniqueDates.length}개 날짜`);
    for (const date of uniqueDates) {
      log(`  📅 ${date} 조회 중...`);
      const result = await fetchPickkoEntries(page, date, { statusKeyword: '', endDate: date });
      pickkoByDate[date] = result;
      log(`  → ${result.entries.length}건 (fetchOk=${result.fetchOk})`);
    }

    // 각 항목 검증
    const results = { found: [], notFound: [], error: [] };

    for (let i = 0; i < targets.length; i++) {
      const { source, id, entry } = targets[i];
      log(`\n━━━ [${i + 1}/${targets.length}] ${maskPhone(entry.phone)} ${entry.date} ━━━`);
      try {
        const phoneRaw = (entry.phoneRaw || entry.phone || '').replace(/\D/g, '');
        const { entries: rows = [], fetchOk = false } = pickkoByDate[entry.date] || {};

        // 일괄 조회 결과에서 매칭 (전화번호 + 시작시간)
        const match = rows.find(r => r.phoneRaw === phoneRaw && r.start === entry.start);

        let viewHref = null;
        if (match) {
          viewHref = '__bulk_match__';
          log(`  ✅ 픽코에 등록됨 (일괄 조회): ${maskPhone(phoneRaw)} ${entry.date} ${entry.start}`);
        } else if (!fetchOk) {
          // 일괄 조회 실패 시 개별 검색으로 폴백
          log(`  ⚠️ 일괄 조회 실패 → 개별 검색 폴백`);
          viewHref = await searchPickko(page, entry);
          if (viewHref) log(`  ✅ 픽코에 등록됨 (개별 검색): ${viewHref}`);
        }

        if (viewHref) {
          await markCompleted(source, id, entry);
          results.found.push(id);
        } else {
          log(`  ⚠️ 픽코 미등록 → 자동 등록 시작`);
          results.notFound.push(id);
          const code = await runPickko(entry);
          if (code === 0) {
            await markCompleted(source, id, entry);
            log(`  ✅ 등록 완료 → completed/auto`);
            // pickkoStatus를 auto로 업데이트
            await updateReservation(id, { pickkoStatus: 'auto' });
          } else if (code === 2) {
            log(`  ⏰ 시간 경과로 등록 생략 → completed/time_elapsed`);
            await markCompleted(source, id, entry);
            await updateReservation(id, {
              pickkoStatus: 'time_elapsed',
              errorReason:  '시간 경과로 등록 불가',
            });
          } else {
            log(`  ❌ 등록 실패 (exit: ${code})`);
            results.error.push(id);
            // retries 증가
            const cur = await getReservation(id);
            await updateReservation(id, { retries: (cur?.retries || 0) + 1 });
          }
        }
      } catch (err) {
        log(`  ❌ 오류: ${err.message}`);
        results.error.push(id);
      }
    }

    // 최종 요약
    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log(`📊 검증 완료 요약`);
    log(`  ✅ 픽코 기존 등록 (completed/verified): ${results.found.length}건`);
    log(`  🤖 픽코 신규 등록 (completed/auto):     ${results.notFound.length}건`);
    log(`  ❌ 처리 실패:                           ${results.error.length}건`);
    log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  } finally {
    if (browser) {
      try { await browser.close(); } catch(e){}
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    log(`❌ 치명 오류: ${err.message}`);
    process.exit(1);
  });
