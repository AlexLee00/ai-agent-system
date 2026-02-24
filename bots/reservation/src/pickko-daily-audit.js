#!/usr/bin/env node

/**
 * pickko-daily-audit.js — 당일 픽코 예약 사후 감사
 *
 * 목적: 픽코 당일 등록 예약 중 네이버 auto 외 전화/수동 예약 탐지 → 텔레그램 리포트
 * 실행: node src/pickko-daily-audit.js
 * 스케줄: 매일 22:00 (launchd: ai.ska.pickko-daily-audit)
 */

const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const path = require('path');
const { delay, log } = require('../lib/utils');
const { loadSecrets } = require('../lib/secrets');
const { loadJson } = require('../lib/files');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../lib/browser');
const { loginToPickko } = require('../lib/pickko');

const SECRETS = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;
const MODE = (process.env.MODE || 'ops').toLowerCase();
const CHAT_ID = '***REMOVED***';

const PROJ_SEEN_FILE = path.join(
  __dirname, '..',
  MODE === 'ops' ? 'naver-seen.json' : 'naver-seen-dev.json'
);

// KST 기준 오늘 날짜 (YYYY-MM-DD)
function getTodayKST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

// 날짜 문자열에서 YYYY-MM-DD 추출
function extractDate(str) {
  if (!str) return '';
  // YYYY-MM-DD
  const m1 = str.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m1) return m1[0];
  // YYYY.MM.DD or YYYY. MM. DD
  const m2 = str.match(/(\d{4})[.\s]+(\d{1,2})[.\s]+(\d{1,2})/);
  if (m2) return `${m2[1]}-${m2[2].padStart(2, '0')}-${m2[3].padStart(2, '0')}`;
  // YYYY년 MM월 DD일
  const m3 = str.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
  if (m3) return `${m3[1]}-${m3[2].padStart(2, '0')}-${m3[3].padStart(2, '0')}`;
  return '';
}

// 시간 문자열 → HH:MM 정규화
function normalizeTime(str) {
  if (!str) return '';
  // 오전/오후 + H시 + M분
  const m1 = str.match(/(오전|오후)\s*(\d+)시\s*(\d+)?분?/);
  if (m1) {
    let h = parseInt(m1[2]);
    const m = parseInt(m1[3] || '0');
    if (m1[1] === '오후' && h !== 12) h += 12;
    if (m1[1] === '오전' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  // 오전/오후 + H:MM
  const m2 = str.match(/(오전|오후)\s*(\d+):(\d{2})/);
  if (m2) {
    let h = parseInt(m2[2]);
    if (m2[1] === '오후' && h !== 12) h += 12;
    if (m2[1] === '오전' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m2[3]}`;
  }
  // HH:MM (plain)
  const m3 = str.match(/(\d{1,2}):(\d{2})/);
  if (m3) return `${m3[1].padStart(2, '0')}:${m3[2]}`;
  // H시 M분 (24시간, 오전/오후 없음 — 픽코 이용일시 형식: "20시 00분")
  const m4 = str.match(/(\d{1,2})시\s*(\d+)?분/);
  if (m4) return `${m4[1].padStart(2, '0')}:${String(parseInt(m4[2] || '0')).padStart(2, '0')}`;
  return '';
}

// 텔레그램 발송
function sendTelegram(message) {
  if (process.env.TELEGRAM_ENABLED === '0') {
    log(`[텔레그램 비활성화] ${message.slice(0, 60)}`);
    return;
  }
  try {
    const child = spawn('openclaw', [
      'agent',
      '--message', `🔔 스카봇\n\n${message}`,
      '--channel', 'telegram',
      '--deliver',
      '--to', CHAT_ID
    ], { stdio: 'ignore', detached: true });
    child.unref();
    log(`📱 [텔레그램] ${message.slice(0, 60)}...`);
  } catch (e) {
    log(`⚠️ 텔레그램 발송 실패: ${e.message}`);
  }
}

// naver-seen.json에서 "네이버 경유" 예약 키 수집
// pickkoStatus 무관: 'auto', 'verified', 'manual' 모두 네이버에서 감지된 예약
// naver-seen.json에 존재 = 네이버 예약 / 없으면 진짜 수동(전화/직접)
function collectNaverKeys() {
  const data = loadJson(PROJ_SEEN_FILE);
  const keys = new Set();
  for (const [id, entry] of Object.entries(data)) {
    if (id === 'seenIds' || id === 'cancelledSeenIds') continue;
    const phoneRaw = (entry.phoneRaw || (entry.phone || '').replace(/\D/g, ''));
    if (!phoneRaw || !entry.date || !entry.start) continue;
    const key = `${phoneRaw}|${entry.date}|${entry.start}`;
    keys.add(key);
  }
  return keys;
}

async function main() {
  const today = getTodayKST();
  log(`\n🔍 픽코 일일 감사 시작: ${today} (MODE=${MODE})`);

  let browser;
  try {
    browser = await puppeteer.launch(getPickkoLaunchOptions());
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, log);

    // ──── 1단계: 로그인 ────
    log('\n[1단계] 픽코 로그인');
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log(`✅ 로그인 완료: ${page.url()}`);

    // ──── 2단계: 예약 목록 페이지 이동 ────
    log('\n[2단계] 예약 목록 페이지 이동');
    await page.goto('https://pickkoadmin.com/study/index.html', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await delay(2000);

    // ──── 3단계: 정렬 기준 → 접수일시 (라디오 버튼 sd_regdate) ────
    log('\n[3단계] 정렬 기준 → 접수일시 (sd_regdate) 라디오 클릭');
    const sortResult = await page.evaluate(() => {
      // o_key 라디오: sd_start=이용일시, sd_regdate=접수일시
      const radio = document.querySelector('input[name="o_key"][value="sd_regdate"]');
      if (radio) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        return { found: true, value: radio.value };
      }
      return { found: false };
    });
    log(`정렬 설정 결과: ${JSON.stringify(sortResult)}`);
    if (!sortResult.found) log('⚠️ sd_regdate 라디오 못 찾음 — 기본 정렬로 진행');

    // ──── 4단계: 검색 버튼 클릭 ────
    log('\n[4단계] 검색 실행');
    try {
      await Promise.all([
        page.click('input[type="submit"][value="검색"]'),
        page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => null)
      ]);
    } catch (e) {
      log(`ℹ️ 검색 버튼: ${e.message}`);
    }
    await delay(2000);

    // ──── 5단계: 테이블 헤더 분석 (thead 마지막 행 기준) ────
    log('\n[5단계] 테이블 컬럼 분석');
    const colMap = await page.evaluate(() => {
      // thead의 마지막 tr 기준으로 th 인덱스 산출 (그룹헤더 행 제외)
      const result = { name: -1, phone: -1, room: -1, startTime: -1, endTime: -1, receiptTime: -1, isCombined: false, headers: [] };
      const theadRows = document.querySelectorAll('thead tr');
      const lastRow = theadRows[theadRows.length - 1];
      const ths = lastRow ? Array.from(lastRow.querySelectorAll('th')) : [];
      ths.forEach((th, i) => {
        const t = th.textContent.trim();
        result.headers.push(t);
        if (t === '이름' || t.includes('회원')) result.name = i;
        if (t === '연락처' || t.includes('전화')) result.phone = i;
        if (t === '스터디룸' || (t.includes('스터디') && !t.includes('이용'))) result.room = i;
        if (t === '이용일시') { result.startTime = i; result.isCombined = true; }
        else if (t.includes('시작') && !t.includes('접수')) result.startTime = i;
        if (t.includes('종료') || t.includes('끝')) result.endTime = i;
        if (t === '접수일시' || (t.includes('접수') && t.includes('일'))) result.receiptTime = i;
      });
      return result;
    });
    log(`헤더: ${JSON.stringify(colMap.headers)}`);
    log(`컬럼 인덱스: name=${colMap.name}, phone=${colMap.phone}, room=${colMap.room}, start=${colMap.startTime}${colMap.isCombined ? '(이용일시/통합)' : ''}, end=${colMap.endTime}, receipt=${colMap.receiptTime}`);

    // ──── 6단계: 당일 접수 예약 수집 ────
    log('\n[6단계] 당일 접수 예약 수집');
    const rawEntries = await page.evaluate((todayStr, cm) => {
      const result = { entries: [], stopped: false, totalRows: 0 };
      const trs = Array.from(document.querySelectorAll('tbody tr'));
      result.totalRows = trs.length;

      for (const tr of trs) {
        const link = tr.querySelector('a[href*="/study/view/"]');
        if (!link) continue;

        const tds = Array.from(tr.querySelectorAll('td'));
        const getText = (idx) => idx >= 0 && tds[idx]
          ? tds[idx].textContent.replace(/\s+/g, ' ').trim()
          : '';

        // 접수일시 컬럼 텍스트
        let receiptText = cm.receiptTime >= 0 ? getText(cm.receiptTime) : '';

        // 폴백: 접수일시 컬럼을 못 찾으면 행 전체에서 날짜 패턴 수집
        if (!receiptText) {
          const allText = tr.textContent.replace(/\s+/g, ' ').trim();
          const dates = allText.match(/\d{4}-\d{2}-\d{2}/g) || [];
          // 마지막 날짜가 접수일시일 가능성이 높음
          receiptText = dates[dates.length - 1] || '';
        }

        // 날짜 추출 (YYYY-MM-DD 우선, YY.M.D 형식도 지원)
        let receiptDate = receiptText.match(/(\d{4})-(\d{2})-(\d{2})/)?.[0] || '';
        if (!receiptDate) {
          // "26. 2. 24" 또는 "2026. 2. 24" 형식
          const m = receiptText.match(/(\d{2,4})[.\s]+(\d{1,2})[.\s]+(\d{1,2})/);
          if (m) {
            const y = m[1].length === 2 ? '20' + m[1] : m[1];
            receiptDate = `${y}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
          }
        }

        // 날짜 파싱 실패 → 해당 행 스킵 (break 금지 — 오류로 전체 중단 방지)
        if (!receiptDate) {
          result.parseErrors = (result.parseErrors || 0) + 1;
          continue;
        }

        if (receiptDate < todayStr) {
          // 접수일시 내림차순 정렬 기준 → 오늘보다 이전이면 이후 행도 이전이므로 중단
          result.stopped = true;
          break;
        }
        if (receiptDate !== todayStr) continue; // 오늘보다 미래 날짜 스킵

        // 데이터 추출
        const name = getText(cm.name);
        const phoneRaw = getText(cm.phone).replace(/[^0-9]/g, '');
        const room = getText(cm.room);
        const combinedText = getText(cm.startTime); // "이용일시" 또는 "시작일시"
        const endText = cm.isCombined ? '' : getText(cm.endTime);

        // 이용일시 통합 컬럼 파싱: "2026-03-05 오후 1:00 ~ 오후 3:00" 또는 "2026년 03월 05일 오후 1:00 ~ 오후 3:00"
        let reservationDate = '';
        let startText = combinedText;

        // 날짜 추출 (YYYY-MM-DD or YYYY년MM월DD일)
        const dateMatcher = combinedText.match(/(\d{4})-(\d{2})-(\d{2})/) ||
          combinedText.match(/(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/);
        if (dateMatcher) {
          if (combinedText.includes('년')) {
            reservationDate = `${dateMatcher[1]}-${dateMatcher[2].padStart(2, '0')}-${dateMatcher[3].padStart(2, '0')}`;
          } else {
            reservationDate = dateMatcher[0];
          }
          // 날짜 이후 텍스트만 시간 파싱에 사용
          startText = combinedText.slice(combinedText.indexOf(dateMatcher[0]) + dateMatcher[0].length).trim();
        }

        // "~" 기준으로 시작/종료 시간 분리
        const tildeIdx = startText.indexOf('~');
        const parsedStart = tildeIdx >= 0 ? startText.slice(0, tildeIdx).trim() : startText;
        const parsedEnd = cm.isCombined
          ? (tildeIdx >= 0 ? startText.slice(tildeIdx + 1).trim() : '')
          : endText;

        result.entries.push({
          name,
          phoneRaw,
          room,
          startText: parsedStart,
          endText: parsedEnd,
          reservationDate,
          receiptText,
          href: link.href
        });
      }
      return result;
    }, today, colMap);

    log(`📋 전체 tbody tr: ${rawEntries.totalRows}행, 당일 접수: ${rawEntries.entries.length}건${rawEntries.stopped ? ' (이전날 데이터 발견, 순회 중단)' : ''}`);

    // ──── 7단계: 수집 데이터 정규화 ────
    log('\n[7단계] 데이터 정규화');
    const pickkoEntries = rawEntries.entries.map(e => {
      const startNorm = normalizeTime(e.startText);
      const endNorm = normalizeTime(e.endText);
      // 예약날짜: startText에 날짜가 있으면 사용, 없으면 오늘 날짜 (동일날 예약인 경우)
      const reservationDate = e.reservationDate || today;
      return {
        name: e.name,
        phoneRaw: e.phoneRaw,
        room: e.room,
        reservationDate,
        startNorm,
        endNorm,
        receiptText: e.receiptText
      };
    });

    for (const e of pickkoEntries) {
      log(`  • ${e.name} ${e.phoneRaw} | ${e.reservationDate} ${e.startNorm}~${e.endNorm} | ${e.room} | 접수: ${e.receiptText.slice(0, 16)}`);
    }

    // ──── 8단계: naver-seen.json 네이버 예약 키와 비교 ────
    log('\n[8단계] naver-seen.json 네이버 예약 키 비교');
    const autoKeys = collectNaverKeys();
    log(`📋 naver-seen 네이버 예약 키 수: ${autoKeys.size}개`);

    const autoMatched = [];
    const manualEntries = [];

    for (const e of pickkoEntries) {
      const key = `${e.phoneRaw}|${e.reservationDate}|${e.startNorm}`;
      if (autoKeys.has(key)) {
        autoMatched.push(e);
        log(`  ✅ auto: ${key}`);
      } else {
        manualEntries.push({ ...e, key });
        log(`  ⚠️ manual: ${key}`);
      }
    }

    // ──── 9단계: 텔레그램 리포트 ────
    log('\n[9단계] 텔레그램 리포트 발송');

    const total = pickkoEntries.length;
    const autoCount = autoMatched.length;
    const manualCount = manualEntries.length;

    let report;
    if (total === 0) {
      report = `📊 픽코 일일 감사 — ${today}\n\n당일 등록된 예약이 없습니다.`;
    } else if (manualCount === 0) {
      report = `📊 픽코 일일 감사 — ${today}\n\n✅ 당일 픽코 등록 ${total}건 모두 auto\n네이버 예약 자동 등록 정상 처리됨`;
    } else {
      const fmtPhone = (raw) => raw.length === 11
        ? `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7)}`
        : raw;

      report = `📊 픽코 일일 감사 — ${today}\n\n`;
      report += `총 ${total}건 | auto ${autoCount}건 | 수동 ${manualCount}건\n\n`;
      report += `⚠️ 수동(전화/직접) 등록 항목:\n`;
      report += `━━━━━━━━━━━━━━━━━━━━━━━━\n`;
      for (const e of manualEntries) {
        report += `• ${e.name || '(이름없음)'} ${e.phoneRaw ? fmtPhone(e.phoneRaw) : '(번호없음)'}\n`;
        report += `  ${e.reservationDate} ${e.startNorm}~${e.endNorm} ${e.room || ''}\n`;
      }
    }

    log('\n' + report);
    sendTelegram(report);
    log('\n✅ 픽코 일일 감사 완료');

  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
}

main().catch(err => {
  log(`❌ 치명 오류: ${err.message}`);
  process.exit(1);
});
