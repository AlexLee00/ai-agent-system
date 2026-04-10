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

const fs        = require('fs');
const puppeteer = require('puppeteer');
const { delay, log } = require('../../lib/utils');
const { loadSecrets } = require('../../lib/secrets');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../../lib/browser');
const { loginToPickko, fetchPickkoEntries } = require('../../lib/pickko');
const { publishToMainBot } = require('../../lib/mainbot-client');
const {
  getAllNaverKeys, getKioskBlocksForDate,
  upsertDailySummary, getUnconfirmedSummaryBefore,
} = require('../../lib/db');
const { fetchDailyDetail } = require('../../lib/pickko-stats');
const { maskName } = require('../../lib/formatting');
const {
  timeToMinutes,
  resolveStudyRoomAmount,
  buildRoomAmountsFromEntries,
} = require('../../lib/study-room-pricing');

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

/**
 * 예약 금액 계산 (룸 타입 × 이용 시간)
 * A1, A2: 3,500원 / 30분 (00:00~09:00 = 2,500원)
 * B:      6,000원 / 30분 (00:00~09:00 = 4,000원)
 */
function calcAmount(entry) {
  return resolveStudyRoomAmount(entry);
}

/**
 * 오늘 kiosk_blocks DB 조회 → { "date|start|room": naverBlocked } 맵
 */
async function getTodayKioskMap(today) {
  const pgPool = require('../../../../packages/core/lib/pg-pool');
  const rows = await pgPool.query('reservation',
    'SELECT date, start_time, room, naver_blocked FROM kiosk_blocks WHERE date = $1',
    [today]);
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
function buildMessage(today, entries, naverKeys, kioskMap, isNoon, pickkoStats = null) {
  const dateHeader = formatDateHeader(today);

  if (entries.length === 0) {
    const base = `📋 오늘 예약 · ${dateHeader}\n\n예약 없음`;
    if (isNoon) {
      const generalRevenue = pickkoStats ? pickkoStats.generalRevenue : 0;
      const baseMsg = base + `\n\n💰 총 매출: ${formatAmount(generalRevenue)}\n\n❓ 오늘 매출을 확정하시겠습니까?`;
      return { msg: baseMsg, totalAmount: generalRevenue, roomAmounts: {} };
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
  const roomAmounts = buildRoomAmountsFromEntries(classified);
  let totalAmount = 0;
  for (const e of classified) {
    const amt = calcAmount(e);
    totalAmount += amt;
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

  const SEP = '━━━━━━━━━━━━━━━';

  let msg = `📋 오늘 예약 · ${dateHeader}\n\n`;
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

  // 00:00 보고 — 룸별 매출 + 컨펌 요청
  if (isNoon) {
    const generalRevenue = pickkoStats ? pickkoStats.generalRevenue : 0;
    const grandTotal = generalRevenue + totalAmount;

    msg += `\n\n💰 매출 현황:\n`;
    if (pickkoStats && generalRevenue > 0) {
      msg += `  일반이용: ${formatAmount(generalRevenue)}\n`;
    }
    for (const [room, amt] of Object.entries(roomAmounts).sort(([a], [b]) => a.localeCompare(b))) {
      msg += `  ${room}: ${formatAmount(amt)}\n`;
    }
    msg += `  합계: ${formatAmount(grandTotal)}\n`;
    msg += `\n❓ 오늘 매출을 확정하시겠습니까?`;

    return { msg, totalAmount: grandTotal, roomAmounts };
  }

  return { msg, totalAmount, roomAmounts };
}

async function main() {
  const hourKST    = getHourKST();
  // 23:50(hour=23) 또는 00:00(hour=0) 실행 시 마감 보고 모드 (pickko 실매출 조회)
  const isMidnight = hourKST === 23 || hourKST === 0 || process.argv.includes('--midnight');
  const today      = getTodayKST();
  // 00:00 실행 시 어제 날짜, 23:50 실행 시 오늘 날짜 대상
  const reportDate = hourKST === 0 ? getYesterdayKST() : today;
  const modeLabel  = hourKST === 23 ? '23:50 마감 보고' : hourKST === 0 ? '00:00 마감 보고' : '09:00 보고';
  log(`\n📋 픽코 일일 요약 시작: ${reportDate} (${modeLabel})`);

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
    // raw entries 진단 (중복 의심 시 분석용)
    if (rawEntries.length > 0) {
      const keyMap = {};
      rawEntries.forEach(e => {
        const k = `${e.date}|${e.start}|${JSON.stringify(e.room)}`;
        keyMap[k] = (keyMap[k] || 0) + 1;
      });
      const dupes = Object.entries(keyMap).filter(([, n]) => n > 1);
      if (dupes.length > 0) {
        log(`  ⚠️ 중복 raw 키 발견: ${dupes.map(([k, n]) => `${k}×${n}`).join(', ')}`);
      }
    }

    // 중복 제거 (date|start|room) — 같은 룸에 같은 시작시간이 중복될 수 없음
    // room 정규화: nbsp(\u00a0), 전각공백(\u3000) 등 모든 공백 제거 후 소문자화
    const _normRoom = s => (s || '').replace(/[\s\u00a0\u3000\ufeff]+/g, '').toLowerCase();
    const _seen = new Set();
    const entries = rawEntries.filter(e => {
      const k = `${e.date}|${e.start}|${_normRoom(e.room)}`;
      if (_seen.has(k)) {
        log(`  [dedup] 중복 제거: ${e.start} ${e.room} ${e.name} (key=${k})`);
        return false;
      }
      _seen.add(k);
      return true;
    });
    log(`📋 당일 예약(dedup): ${entries.length}건`);

    // ──── 3단계: DB 분류 데이터 조회 ────
    log('\n[3단계] DB 분류 데이터 조회');
    const naverKeys = await getAllNaverKeys();
    const kioskMap  = await getTodayKioskMap(reportDate);
    log(`  naverKeys: ${naverKeys.size}개, kioskBlocks(오늘): ${Object.keys(kioskMap).length}개`);

    for (const e of entries) {
      const cls = classifyEntry(e, naverKeys, kioskMap);
      log(`  • ${e.start}~${e.end} ${e.room} ${maskName(e.name)} ${calcAmount(e)}원 → ${classifyLabel(cls)}`);
    }

    // ──── 3-B단계: 픽코 실제 매출 조회 (자정 실행 시만) ────
    let pickkoStats = null;
    if (isMidnight) {
      log('\n[3-B단계] 픽코 실제 매출 조회');
      try {
        pickkoStats = await fetchDailyDetail(page, reportDate);
        const studyTotal = Object.values(pickkoStats.studyRoomRevenue).reduce((s, v) => s + v, 0);
        log(`  픽코 총매출: ${pickkoStats.totalRevenue}원`);
        log(`  픽코 스터디룸: ${studyTotal}원 (${JSON.stringify(pickkoStats.studyRoomRevenue)})`);
        log(`  일반이용: ${pickkoStats.generalRevenue}원`);
      } catch (err) {
        log(`  ⚠️ 픽코 매출 조회 실패 (건너뜀): ${err.message}`);
        pickkoStats = null;
      }
    }

    // ──── 4단계: 메시지 생성 & DB 저장 ────
    log('\n[4단계] 메시지 생성 & DB 저장');
    const result = buildMessage(reportDate, entries, naverKeys, kioskMap, isMidnight, pickkoStats);

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
    const entryStudyRoomTotal = Object.values(roomAmounts || {}).reduce((s, v) => s + Number(v || 0), 0);
    const statsStudyRoomTotal = pickkoStats
      ? Object.values(pickkoStats.studyRoomRevenue).reduce((s, v) => s + v, 0)
      : 0;
    const pickkoStudyRoomTotal = pickkoStats
      ? (statsStudyRoomTotal > 0 ? statsStudyRoomTotal : entryStudyRoomTotal)
      : 0;
    // 일반이용 매출은 픽코 일별 상세의 direct generalRevenue를 그대로 사용한다.
    // 스터디룸 배분(use-day)과 잔차식(total-studyroom)을 섞으면 축이 달라져 왜곡된다.
    const resolvedGeneralRevenue = pickkoStats
      ? Number(pickkoStats.generalRevenue || 0)
      : null;
    upsertDailySummary(reportDate, {
      totalAmount,
      roomAmounts,
      entriesCount:    entries.length,
      pickkoStudyRoom: pickkoStats ? pickkoStudyRoomTotal : null,
      generalRevenue:  resolvedGeneralRevenue,
    });
    log(`  daily_summary 저장: ${reportDate} | ${totalAmount}원 | ${entries.length}건`);

    // ──── 5단계: 전날 미컨펌 리마인드 (09:00 보고 시만) ────
    // 최근 3일 이내 미컨펌만 알림 (오래된 미컨펌은 무시)
    if (!isMidnight) {
      const cutoff3days = new Date(today);
      cutoff3days.setDate(cutoff3days.getDate() - 3);
      const cutoff3str = cutoff3days.toISOString().slice(0, 10);
      const unconfirmed = getUnconfirmedSummaryBefore(today);

      if (unconfirmed && unconfirmed.date >= cutoff3str) {
        const prevHeader = formatDateHeader(unconfirmed.date);
        const prevRoomLines = Object.entries(unconfirmed.roomAmounts)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([r, a]) => `  ${r}: ${formatAmount(a)}`)
          .join('\n');
        const remindMsg =
          `⚠️ 미컨펌 알림 — ${prevHeader}\n\n` +
          `${prevRoomLines}\n` +
          `  합계: ${formatAmount(unconfirmed.total_amount)}\n\n` +
          `❓ ${prevHeader} 매출이 아직 확정되지 않았습니다. 지금 확정하시겠습니까?`;
        log('\n미컨펌 리마인드 발송:\n' + remindMsg);
        publishToMainBot({ from_bot: 'ska', event_type: 'report', alert_level: 2, message: remindMsg });
      }
    }

    // ──── 6단계: 텔레그램 발송 (30분 중복 방지) ────
    log('\n[6단계] 텔레그램 발송');
    const slot        = isMidnight ? 'night' : 'morning';
    const guardFile   = `/tmp/pickko-daily-summary-${reportDate}-${slot}.guard`;
    const COOLDOWN_MS = 30 * 60 * 1000; // 30분

    let skipSend = false;
    if (fs.existsSync(guardFile)) {
      const sentAt = new Date(fs.readFileSync(guardFile, 'utf8').trim());
      const ageMs  = Date.now() - sentAt.getTime();
      if (ageMs < COOLDOWN_MS) {
        log(`⏭ 텔레그램 발송 스킵 — ${Math.floor(ageMs / 60000)}분 전 이미 발송됨 (30분 쿨다운)`);
        skipSend = true;
      }
    }

    if (!skipSend) {
      fs.writeFileSync(guardFile, new Date().toISOString());
      log('\n' + msg);
      publishToMainBot({ from_bot: 'ska', event_type: 'report', alert_level: 1, message: msg });
    }
    log('\n✅ 픽코 일일 요약 완료');

  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    log(`❌ 치명 오류: ${err.message}`);
    process.exit(1);
  });
