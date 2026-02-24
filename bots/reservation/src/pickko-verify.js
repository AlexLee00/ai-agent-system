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
const { delay, log } = require('../lib/utils');
const { loadSecrets } = require('../lib/secrets');
const { toKoreanTime, pickkoEndTime, formatPhone } = require('../lib/formatting');
const { loadJson, saveJson } = require('../lib/files');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../lib/browser');
const { loginToPickko } = require('../lib/pickko');

// ──────────────────────────────────────────────
// 설정
// ──────────────────────────────────────────────
const SECRETS    = loadSecrets();
const PICKKO_ID  = SECRETS.pickko_id;
const PICKKO_PW  = SECRETS.pickko_pw;
const MODE       = (process.env.MODE || 'ops').toLowerCase();
const DRY_RUN    = process.argv.includes('--dry-run');

const WORKSPACE      = path.join(process.env.HOME, '.openclaw', 'workspace');
const PROJ_SEEN_FILE = path.join(__dirname, '..', MODE === 'ops' ? 'naver-seen.json' : 'naver-seen-dev.json');
const WS_SEEN_FILE   = path.join(WORKSPACE, 'naver-seen.json');

// ──────────────────────────────────────────────
// pending/failed/미검증completed 항목 수집
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

function collectTargets() {
  const targets = [];
  const seen    = new Set(); // 중복 방지 (compositeKey 기준)

  // 1. 프로젝트 파일
  const projData = loadJson(PROJ_SEEN_FILE);
  for (const [id, entry] of Object.entries(projData)) {
    if (id === 'seenIds' || id === 'cancelledSeenIds') continue;
    if (needsVerify(entry)) {
      const ck = entry.compositeKey || id;
      if (!seen.has(ck)) {
        seen.add(ck);
        targets.push({ source: 'proj', id, entry });
      }
    }
  }

  // 2. workspace 파일 (pending)
  const wsData = loadJson(WS_SEEN_FILE);
  for (const [id, entry] of Object.entries(wsData)) {
    if (id === 'seenIds' || id === 'cancelledSeenIds') continue;
    if (entry.status === 'pending') {
      const ck = entry.compositeKey || id;
      if (!seen.has(ck)) {
        seen.add(ck);
        targets.push({ source: 'ws', id, entry });
      }
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

  log(`  🔍 검색: ${phone} | ${date} | ${entry.start}~${entry.end} | ${entry.room}룸`);

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

  // 검색
  await Promise.all([
    page.click('input[type="submit"].btn_box'),
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
// 상태 업데이트
// ──────────────────────────────────────────────
function markCompleted(source, id, entry) {
  const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });

  // 프로젝트 파일에 반영
  const projData = loadJson(PROJ_SEEN_FILE);
  projData[id] = {
    compositeKey:    entry.compositeKey || `${(entry.phoneRaw||entry.phone||'').replace(/\D/g,'')}`,
    phone:           entry.phone,
    phoneRaw:        entry.phoneRaw || (entry.phone||'').replace(/\D/g,''),
    date:            entry.date,
    start:           entry.start,
    end:             entry.end,
    room:            entry.room,
    detectedAt:      entry.detectedAt,
    status:          'completed',
    pickkoStatus:    'verified',   // 픽코에서 존재 확인됨
    pickkoOrderId:   null,
    errorReason:     null,
    retries:         entry.retries || 0,
    pickkoStartTime: now,
  };
  // seenIds에도 추가 (중복 방지)
  if (!Array.isArray(projData.seenIds)) projData.seenIds = [];
  if (!projData.seenIds.includes(id)) projData.seenIds.push(id);
  saveJson(PROJ_SEEN_FILE, projData);

  // workspace 파일도 업데이트
  if (source === 'ws') {
    const wsData = loadJson(WS_SEEN_FILE);
    if (wsData[id]) {
      wsData[id].status      = 'completed';
      wsData[id].pickkoStatus = 'verified';
      saveJson(WS_SEEN_FILE, wsData);
    }
  }
}

// ──────────────────────────────────────────────
// pickko-accurate.js 실행
// ──────────────────────────────────────────────
function runPickko(entry) {
  return new Promise(resolve => {
    const phone = (entry.phoneRaw || entry.phone || '').replace(/\D/g,'');
    const args  = [
      'pickko-accurate.js',
      `--phone=${phone}`,
      `--date=${entry.date}`,
      `--start=${entry.start}`,
      `--end=${entry.end}`,
      `--room=${entry.room}`,
      `--name=${entry.raw?.name || '고객'}`
    ];
    log(`  🤖 픽코 등록 실행: ${phone} ${entry.date} ${entry.start}~${entry.end} ${entry.room}룸`);
    const child = spawn('node', args, { cwd: __dirname, stdio: 'inherit' });
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
  const targets = collectTargets();

  if (targets.length === 0) {
    log('✅ 검증 대상 없음');
    return;
  }

  log(`\n📋 검증 대상: ${targets.length}건`);
  for (const { source, id, entry } of targets) {
    log(`  [${source}] ${id} | ${entry.phone} | ${entry.date} ${entry.start}~${entry.end} | ${entry.room}룸 | status=${entry.status} | retries=${entry.retries||0}`);
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
    log('\n[1단계] 픽코 로그인');
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log(`✅ 로그인 완료: ${page.url()}`);

    // 각 항목 검증
    const results = { found: [], notFound: [], error: [] };

    for (const { source, id, entry } of targets) {
      log(`\n━━━ [${targets.indexOf({ source, id, entry }) + 1}/${targets.length}] ${entry.phone} ${entry.date} ━━━`);
      try {
        const viewHref = await searchPickko(page, entry);

        if (viewHref) {
          log(`  ✅ 픽코에 등록됨: ${viewHref}`);
          markCompleted(source, id, entry);
          results.found.push(id);
        } else {
          log(`  ⚠️ 픽코 미등록 → 자동 등록 시작`);
          results.notFound.push(id);
          const code = await runPickko(entry);
          if (code === 0) {
            markCompleted(source, id, entry);
            log(`  ✅ 등록 완료 → completed/auto`);
            // pickkoStatus를 auto로 업데이트
            const projData = loadJson(PROJ_SEEN_FILE);
            if (projData[id]) projData[id].pickkoStatus = 'auto';
            saveJson(PROJ_SEEN_FILE, projData);
          } else {
            log(`  ❌ 등록 실패 (exit: ${code})`);
            results.error.push(id);
            // 프로젝트 파일에 retries 증가
            const projData = loadJson(PROJ_SEEN_FILE);
            if (projData[id]) {
              projData[id].retries = (projData[id].retries || 0) + 1;
            }
            saveJson(PROJ_SEEN_FILE, projData);
          }
        }
      } catch (err) {
        log(`  ❌ 오류: ${err.message}`);
        results.error.push(id);
      }

      // 항목 간 딜레이 (픽코 부하 방지)
      if (targets.indexOf(targets.find(t => t.id === id)) < targets.length - 1) {
        await delay(2000);
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

main().catch(err => {
  log(`❌ 치명 오류: ${err.message}`);
  process.exit(1);
});
