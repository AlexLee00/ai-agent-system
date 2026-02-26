#!/usr/bin/env node

/**
 * pickko-daily-summary.js — 당일 예약 현황 보고
 *
 * 09:00 실행: 예약현황만 보고 + 전날 미컨펌 리마인드
 * 00:00 실행: 어제 영업 마감 — 예약현황 + 매출 + 컨펌 요청
 *
 * 분류 기준:
 *   [네이버]       - naver-monitor가 픽코 등록한 예약 (네이버 원본)
 *   [키오스크 ✅]  - 키오스크 예약 + 네이버 차단 완료
 *   [키오스크 ⚠️]  - 키오스크 예약 + 네이버 차단 미완료
 *   [수동]         - 전화/직접 등록 예약
 *
 * 스케줄: 매일 09:00, 00:00 (launchd: ai.ska.pickko-daily-summary)
 */

const puppeteer = require('puppeteer');
const { delay, log } = require('../lib/utils');
const { loadSecrets } = require('../lib/secrets');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../lib/browser');
const { loginToPickko, fetchPickkoEntries } = require('../lib/pickko');
const { sendTelegram } = require('../lib/telegram');
const {
  getAllNaverKeys, getDb,
  upsertDailySummary, getUnconfirmedSummaryBefore,
} = require('../lib/db');

const SECRETS = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;

// KST 기준 오늘 날짜 (YYYY-MM-DD)
function getTodayKST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

// KST 현재 시각 (시 단위)
function getHourKST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getHours();
}

// KST 기준 어제 날짜 (YYYY-MM-DD)
function getYesterdayKST() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// 날짜 헤더용 포맷 (02/26 (목))
function formatDateHeader(dateStr) {
  const d = new Date(dateStr + 'T00:00:00+09:00');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  const dow = dayNames[d.getDay()];
  return `${mm}/${dd} (${dow})`;
}

// 금액 포맷 (12000 → 12,000원)
function formatAmount(amount) {
  if (!amount && amount !== 0) return '?원';
  return Number(amount).toLocaleString('ko-KR') + '원';
}

// 시간 → 분 (정렬용)
function timeToMinutes(t) {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/**
 * 예약 금액 계산 (룸 타입 × 이용 시간)
 * A1, A2: 3,500원 / 30분
 * B:      6,000원 / 30분
 */
function calcAmount(entry) {
  const room = entry.room || '';
  const isRoomB = /스터디룸\s*B/i.test(room) || /룸\s*B$/i.test(room);
  const ratePerSlot = isRoomB ? 6000 : 3500;

  const startMin = timeToMinutes(entry.start);
  const endMin   = timeToMinutes(entry.end);
  const durationMin = endMin - startMin;
  if (durationMin <= 0) return 0;

  return Math.ceil(durationMin / 30) * ratePerSlot;
}

/**
 * 오늘 kiosk_blocks DB 조회 → { "date|start|room": naverBlocked } 맵
 */
function getTodayKioskMap(today) {
  const db = getDb();
  const rows = db.prepare('SELECT date, start_time, room, naver_blocked FROM kiosk_blocks WHERE date = ?').all(today);
  const map = {};
  for (const row of rows) {
    const key = `${row.date}|${row.start_time}|${row.room || ''}`;
    map[key] = row.naver_blocked === 1;
  }
  return map;
}

/**
 * 픽코 예약 항목 분류
 */
function classifyEntry(e, naverKeys, kioskMap) {
  const naverKey = `${e.phoneRaw}|${e.date}|${e.start}`;
  if (e.phoneRaw && naverKeys.has(naverKey)) return { type: 'naver', naverBlocked: null };

  const kioskKey = `${e.date}|${e.start}|${e.room || ''}`;
  if (kioskKey in kioskMap) return { type: 'kiosk', naverBlocked: kioskMap[kioskKey] };

  return { type: 'manual', naverBlocked: null };
}

function classifyLabel(cls) {
  if (cls.type === 'naver') return '[네이버]';
  if (cls.type === 'kiosk') return cls.naverBlocked ? '[키오스크 ✅]' : '[키오스크 ⚠️]';
  return '[수동]';
}

/**
 * 예약 목록 → 텔레그램 메시지 생성
 * isNoon=true 이면 매출 + 컨펌 요청 포함
 */
function buildMessage(today, entries, naverKeys, kioskMap, isNoon) {
  const dateHeader = formatDateHeader(today);

  if (entries.length === 0) {
    const base = `📋 오늘 예약 현황 — ${dateHeader}\n\n예약 없음`;
    if (isNoon) {
      return base + '\n\n💰 총 매출: 0원\n\n❓ 오늘 매출을 확정하시겠습니까?';
    }
    return base;
  }

  // 시간순 정렬
  const sorted = [...entries].sort((a, b) => {
    const diff = timeToMinutes(a.start) - timeToMinutes(b.start);
    return diff !== 0 ? diff : (a.room || '').localeCompare(b.room || '');
  });

  // 각 항목 분류
  const classified = sorted.map(e => ({ ...e, cls: classifyEntry(e, naverKeys, kioskMap) }));

  // 총 금액 & 룸별 금액
  const roomAmounts = {};
  let totalAmount = 0;
  for (const e of classified) {
    const amt = calcAmount(e);
    totalAmount += amt;
    const r = e.room || '?';
    roomAmounts[r] = (roomAmounts[r] || 0) + amt;
  }

  // 룸별 건수
  const roomCount = {};
  for (const e of sorted) {
    const r = e.room || '?';
    roomCount[r] = (roomCount[r] || 0) + 1;
  }
  const roomSummary = Object.entries(roomCount)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([room, cnt]) => `${room}×${cnt}`)
    .join(' / ');

  const SEP = '━━━━━━━━━━━━━━━━━━━━━━━━';

  let msg = `📋 오늘 예약 현황 — ${dateHeader}\n\n`;
  msg += `총 ${sorted.length}건 | ${formatAmount(totalAmount)}\n`;
  msg += `${SEP}\n`;

  for (const e of classified) {
    const name  = e.name || '(이름없음)';
    const room  = e.room || '?';
    const start = e.start || '?';
    const end   = e.end || '?';
    const amt   = formatAmount(calcAmount(e));
    const tag   = classifyLabel(e.cls);
    msg += `${start}~${end}  ${room}  ${name}  ${amt}  ${tag}\n`;
  }

  msg += `${SEP}\n`;
  msg += roomSummary;

  // 주의 항목
  const unblocked = classified.filter(e => e.cls.type === 'kiosk' && !e.cls.naverBlocked);
  const manual    = classified.filter(e => e.cls.type === 'manual');

  if (unblocked.length > 0) {
    msg += `\n\n⚠️ 네이버 차단 미완료 (${unblocked.length}건):`;
    for (const e of unblocked) {
      msg += `\n• ${e.start}~${e.end} ${e.room} ${e.name || '(이름없음)'}`;
    }
  }
  if (manual.length > 0) {
    msg += `\n\n📞 수동 등록 — 네이버 확인 필요 (${manual.length}건):`;
    for (const e of manual) {
      msg += `\n• ${e.start}~${e.end} ${e.room} ${e.name || '(이름없음)'}`;
    }
  }

  // 12:00 보고 — 룸별 매출 + 컨펌 요청
  if (isNoon) {
    msg += `\n\n💰 룸별 매출:\n`;
    for (const [room, amt] of Object.entries(roomAmounts).sort(([a], [b]) => a.localeCompare(b))) {
      msg += `  ${room}: ${formatAmount(amt)}\n`;
    }
    msg += `  합계: ${formatAmount(totalAmount)}\n`;
    msg += `\n❓ 오늘 매출을 확정하시겠습니까?`;
  }

  return { msg, totalAmount, roomAmounts };
}

async function main() {
  const hourKST    = getHourKST();
  const isMidnight = hourKST === 0; // 00:00 실행 → 어제 영업일 마감 보고
  const today      = getTodayKST();
  // 자정 실행 시 어제 날짜를 대상으로 보고
  const reportDate = isMidnight ? getYesterdayKST() : today;
  log(`\n📋 픽코 일일 요약 시작: ${reportDate} (${isMidnight ? '00:00 마감 보고' : '09:00 보고'})`);

  let browser;
  try {
    browser = await puppeteer.launch(getPickkoLaunchOptions());
    const pages = await browser.pages();
    const page  = pages[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, log);

    // ──── 1단계: 로그인 ────
    log('\n[1단계] 픽코 로그인');
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log(`✅ 로그인 완료: ${page.url()}`);

    // ──── 2단계: 대상일 예약 전체 조회 ────
    log(`\n[2단계] ${reportDate} 예약 전체 조회 (결제완료)`);
    const { entries: rawEntries, fetchOk } = await fetchPickkoEntries(page, reportDate, {
      sortBy:        'sd_start',
      endDate:       reportDate,
      statusKeyword: '결제완료',
    });
    log(`📋 당일 예약(raw): ${rawEntries.length}건 (fetchOk=${fetchOk})`);

    // 중복 제거 (date|start|end|room)
    const _seen = new Set();
    const entries = rawEntries.filter(e => {
      const k = `${e.date}|${e.start}|${e.end}|${e.room}`;
      if (_seen.has(k)) return false;
      _seen.add(k);
      return true;
    });
    log(`📋 당일 예약(dedup): ${entries.length}건`);

    // ──── 3단계: DB 분류 데이터 조회 ────
    log('\n[3단계] DB 분류 데이터 조회');
    const naverKeys = getAllNaverKeys();
    const kioskMap  = getTodayKioskMap(reportDate);
    log(`  naverKeys: ${naverKeys.size}개, kioskBlocks(오늘): ${Object.keys(kioskMap).length}개`);

    for (const e of entries) {
      const cls = classifyEntry(e, naverKeys, kioskMap);
      log(`  • ${e.start}~${e.end} ${e.room} ${e.name} ${calcAmount(e)}원 → ${classifyLabel(cls)}`);
    }

    // ──── 4단계: 메시지 생성 & DB 저장 ────
    log('\n[4단계] 메시지 생성 & DB 저장');
    const result = buildMessage(reportDate, entries, naverKeys, kioskMap, isMidnight);

    // result는 예약 없을 때 string, 있을 때 { msg, totalAmount, roomAmounts }
    let msg, totalAmount = 0, roomAmounts = {};
    if (typeof result === 'string') {
      msg = result;
    } else {
      msg = result.msg;
      totalAmount = result.totalAmount;
      roomAmounts = result.roomAmounts;
    }

    // daily_summary DB 저장 (매 보고마다 최신 데이터로 갱신)
    upsertDailySummary(reportDate, {
      totalAmount,
      roomAmounts,
      entriesCount: entries.length,
    });
    log(`  daily_summary 저장: ${reportDate} | ${totalAmount}원 | ${entries.length}건`);

    // ──── 5단계: 전날 미컨펌 리마인드 (09:00 보고 시만) ────
    if (!isMidnight) {
      const unconfirmed = getUnconfirmedSummaryBefore(today);

      if (unconfirmed) {
        const prevHeader = formatDateHeader(unconfirmed.date);
        const prevRoomLines = Object.entries(unconfirmed.roomAmounts)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([r, a]) => `  ${r}: ${formatAmount(a)}`)
          .join('\n');
        const remindMsg =
          `⚠️ 미컨펌 알림 — ${prevHeader}\n\n` +
          `${prevRoomLines}\n` +
          `  합계: ${formatAmount(unconfirmed.total_amount)}\n\n` +
          `❓ 어제 매출이 아직 확정되지 않았습니다. 지금 확정하시겠습니까?`;
        log('\n미컨펌 리마인드 발송:\n' + remindMsg);
        sendTelegram(remindMsg);
      }
    }

    // ──── 6단계: 텔레그램 발송 ────
    log('\n[6단계] 텔레그램 발송');
    log('\n' + msg);
    sendTelegram(msg);
    log('\n✅ 픽코 일일 요약 완료');

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
