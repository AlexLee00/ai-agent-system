#!/usr/bin/env node

const fs = require('fs');
const puppeteer = require('puppeteer');
const { delay, log } = require('../../lib/utils');
const { loadSecrets } = require('../../lib/secrets');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../../lib/browser');
const { loginToPickko, fetchPickkoEntries } = require('../../lib/pickko');
const { publishReservationAlert } = require('../../lib/alert-client');
const {
  getAllNaverKeys, upsertDailySummary, getUnconfirmedSummaryBefore, confirmDailySummary,
} = require('../../lib/db');
const { fetchDailyDetail } = require('../../lib/pickko-stats');
const { maskName } = require('../../lib/formatting');
const {
  getTodayKST,
  getHourKST,
  getYesterdayKST,
  formatDateHeader,
  formatAmount,
  calcAmount,
  classifyEntry,
  classifyLabel,
  buildDailySummaryMessage,
} = require('../../lib/daily-report-helpers');

const SECRETS = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;

async function getTodayKioskMap(today: string) {
  const pgPool = require('../../../../packages/core/lib/pg-pool');
  const rows = await pgPool.query(
    'reservation',
    'SELECT date, start_time, room, naver_blocked FROM kiosk_blocks WHERE date = $1',
    [today],
  );
  const map: Record<string, boolean> = {};
  for (const row of rows) {
    const key = `${row.date}|${row.start_time}|${row.room || ''}`;
    map[key] = row.naver_blocked === 1;
  }
  return map;
}

async function main() {
  const hourKST = getHourKST();
  const isMidnight = hourKST === 23 || hourKST === 0 || process.argv.includes('--midnight');
  const today = getTodayKST();
  const reportDate = hourKST === 0 ? getYesterdayKST() : today;
  const modeLabel = hourKST === 23 ? '23:50 마감 보고' : hourKST === 0 ? '00:00 마감 보고' : '09:00 보고';
  log(`\n📋 픽코 일일 요약 시작: ${reportDate} (${modeLabel})`);

  let browser: any;
  try {
    browser = await puppeteer.launch(getPickkoLaunchOptions());
    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, log);

    log('\n[1단계] 픽코 로그인');
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log(`✅ 로그인 완료: ${page.url()}`);

    log(`\n[2단계] ${reportDate} 예약 전체 조회 (결제완료)`);
    const { entries: rawEntries, fetchOk } = await fetchPickkoEntries(page, reportDate, {
      sortBy: 'sd_start',
      endDate: reportDate,
      statusKeyword: '결제완료',
    });
    log(`📋 당일 예약(raw): ${rawEntries.length}건 (fetchOk=${fetchOk})`);

    if (rawEntries.length > 0) {
      const keyMap: Record<string, number> = {};
      rawEntries.forEach((e: any) => {
        const k = `${e.date}|${e.start}|${JSON.stringify(e.room)}`;
        keyMap[k] = (keyMap[k] || 0) + 1;
      });
      const dupes = Object.entries(keyMap).filter(([, n]) => n > 1);
      if (dupes.length > 0) {
        log(`  ⚠️ 중복 raw 키 발견: ${dupes.map(([k, n]) => `${k}×${n}`).join(', ')}`);
      }
    }

    const normRoom = (s: string) => (s || '').replace(/[\s\u00a0\u3000\ufeff]+/g, '').toLowerCase();
    const seen = new Set<string>();
    const entries = rawEntries.filter((e: any) => {
      const k = `${e.date}|${e.start}|${normRoom(e.room)}`;
      if (seen.has(k)) {
        log(`  [dedup] 중복 제거: ${e.start} ${e.room} ${e.name} (key=${k})`);
        return false;
      }
      seen.add(k);
      return true;
    });
    log(`📋 당일 예약(dedup): ${entries.length}건`);

    log('\n[3단계] DB 분류 데이터 조회');
    const naverKeys = await getAllNaverKeys();
    const kioskMap = await getTodayKioskMap(reportDate);
    log(`  naverKeys: ${naverKeys.size}개, kioskBlocks(오늘): ${Object.keys(kioskMap).length}개`);

    for (const e of entries) {
      const cls = classifyEntry(e, naverKeys, kioskMap);
      log(`  • ${e.start}~${e.end} ${e.room} ${maskName(e.name)} ${calcAmount(e)}원 → ${classifyLabel(cls)}`);
    }

    let pickkoStats: any = null;
    if (isMidnight) {
      log('\n[3-B단계] 픽코 실제 매출 조회');
      try {
        pickkoStats = await fetchDailyDetail(page, reportDate);
        const studyTotal = Object.values(pickkoStats.studyRoomRevenue).reduce((s: number, v: any) => s + v, 0);
        log(`  픽코 총매출: ${pickkoStats.totalRevenue}원`);
        log(`  픽코 스터디룸: ${studyTotal}원 (${JSON.stringify(pickkoStats.studyRoomRevenue)})`);
        log(`  일반이용: ${pickkoStats.generalRevenue}원`);
      } catch (err: any) {
        log(`  ⚠️ 픽코 매출 조회 실패 (건너뜀): ${err.message}`);
        pickkoStats = null;
      }
    }

    log('\n[4단계] 메시지 생성 & DB 저장');
    const result = buildDailySummaryMessage(reportDate, entries, naverKeys, kioskMap, isMidnight, pickkoStats);

    let msg: string;
    let totalAmount = 0;
    let roomAmounts: Record<string, number> = {};
    if (typeof result === 'string') {
      msg = result;
    } else {
      msg = result.msg;
      totalAmount = result.totalAmount;
      roomAmounts = result.roomAmounts;
    }

    const entryStudyRoomTotal = Object.values(roomAmounts || {}).reduce((s, v) => s + Number(v || 0), 0);
    const statsStudyRoomTotal: number = pickkoStats
      ? Number(Object.values(pickkoStats.studyRoomRevenue).reduce((s: number, v: any) => s + v, 0))
      : 0;
    const pickkoStudyRoomTotal = pickkoStats
      ? (statsStudyRoomTotal > 0 ? statsStudyRoomTotal : entryStudyRoomTotal)
      : 0;
    const resolvedGeneralRevenue = pickkoStats ? Number(pickkoStats.generalRevenue || 0) : null;

    upsertDailySummary(reportDate, {
      totalAmount,
      roomAmounts,
      entriesCount: entries.length,
      pickkoStudyRoom: pickkoStats ? pickkoStudyRoomTotal : null,
      generalRevenue: resolvedGeneralRevenue,
    });
    log(`  daily_summary 저장: ${reportDate} | ${totalAmount}원 | ${entries.length}건`);

    // 자정 리포트 → 매출 자동 확정! (알람 없이 기록만!)
    if (isMidnight) {
      try {
        const autoConfirm = await confirmDailySummary(reportDate);
        if (autoConfirm) {
          log(`  ✅ ${reportDate} 매출 자동 확정 완료: ${totalAmount}원`);
        }
      } catch (confirmErr: any) {
        log(`  ⚠️ ${reportDate} 매출 자동 확정 에러: ${confirmErr.message}`);
      }
    }

    if (!isMidnight) {
      const cutoff3days = new Date(today);
      cutoff3days.setDate(cutoff3days.getDate() - 3);
      const cutoff3str = cutoff3days.toISOString().slice(0, 10);
      const unconfirmed = getUnconfirmedSummaryBefore(today);

      if (unconfirmed && unconfirmed.date >= cutoff3str) {
        const prevHeader = formatDateHeader(unconfirmed.date);
        log(`\n미컨펌 감지 — ${prevHeader} → 자동 확정 처리`);
        try {
          const confirmResult = await confirmDailySummary(unconfirmed.date);
          if (confirmResult) {
            log(`  ✅ ${prevHeader} 매출 자동 확정 완료: ${unconfirmed.total_amount}원`);
          } else {
            log(`  ⚠️ ${prevHeader} 매출 자동 확정 실패 (데이터 없음)`);
          }
        } catch (confirmErr: any) {
          log(`  ⚠️ ${prevHeader} 매출 자동 확정 에러: ${confirmErr.message}`);
        }
      }
    }

    log('\n[6단계] 텔레그램 발송');
    const slot = isMidnight ? 'night' : 'morning';
    const guardFile = `/tmp/pickko-daily-summary-${reportDate}-${slot}.guard`;
    const cooldownMs = 30 * 60 * 1000;

    let skipSend = false;
    if (fs.existsSync(guardFile)) {
      const sentAt = new Date(fs.readFileSync(guardFile, 'utf8').trim());
      const ageMs = Date.now() - sentAt.getTime();
      if (ageMs < cooldownMs) {
        log(`⏭ 텔레그램 발송 스킵 — ${Math.floor(ageMs / 60000)}분 전 이미 발송됨 (30분 쿨다운)`);
        skipSend = true;
      }
    }

    if (!skipSend) {
      fs.writeFileSync(guardFile, new Date().toISOString());
      log('\n' + msg);
      publishReservationAlert({ from_bot: 'ska', event_type: 'report', alert_level: 1, message: msg });
    }
    log('\n✅ 픽코 일일 요약 완료');
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_e) {}
    }
  }
}

module.exports = {
  getTodayKioskMap,
  main,
};

main()
  .then(() => process.exit(0))
  .catch((err: any) => {
    log(`❌ 치명 오류: ${err.message}`);
    process.exit(1);
  });
