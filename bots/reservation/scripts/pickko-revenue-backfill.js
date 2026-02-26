#!/usr/bin/env node
'use strict';

/**
 * scripts/pickko-revenue-backfill.js — 픽코 매출 이력 DB 일괄 채우기
 *
 * 픽코 매출통계 페이지에서 월별 → 일별 상세를 파싱해 daily_summary 테이블에 저장.
 * 기존 레코드는 ON CONFLICT UPDATE (confirmed 상태 유지).
 *
 * 저장 구조:
 *   스터디카페 (일반이용)  → general_revenue
 *   스터디룸 (A1/A2/B)   → pickko_study_room + room_amounts_json
 *   합계                  → pickko_total
 *
 * 완료 후 예측용 CSV 자동 생성:
 *   ~/.openclaw/workspace/revenue-history.csv
 *   컬럼: date, day_of_week, is_weekend, study_cafe, room_a1, room_a2, room_b, study_room_total, total
 *
 * 사용법:
 *   PICKKO_HEADLESS=1 node scripts/pickko-revenue-backfill.js
 *   PICKKO_HEADLESS=1 node scripts/pickko-revenue-backfill.js --from=2025-10 --to=2026-02
 *   PICKKO_HEADLESS=1 node scripts/pickko-revenue-backfill.js --dry-run
 *
 * 기본값: --from=2025-10, --to=현재월(KST)
 */

const puppeteer = require('puppeteer');
const fs        = require('fs');
const path      = require('path');
const { delay, log } = require('../lib/utils');
const { loadSecrets } = require('../lib/secrets');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../lib/browser');
const { loginToPickko } = require('../lib/pickko');
const { upsertDailySummary, getDailySummariesInRange } = require('../lib/db');
const { fetchMonthlyRevenue, fetchDailyDetail } = require('../lib/pickko-stats');

const SECRETS   = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;

const WORKSPACE = path.join(process.env.HOME, '.openclaw', 'workspace');
const CSV_PATH  = path.join(WORKSPACE, 'revenue-history.csv');

// ─── CLI 인자 파싱 ─────────────────────────────────────────────
const argv    = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');

function getArg(name) {
  const a = argv.find(s => s.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : null;
}

function getCurrentMonthKST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(0, 7);
}

const FROM_MONTH = getArg('from') || '2025-10';
const TO_MONTH   = getArg('to')   || getCurrentMonthKST();

// ─── 월 범위 생성 ──────────────────────────────────────────────
function monthsInRange(from, to) {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  const months = [];
  let y = fy, m = fm;
  while (y < ty || (y === ty && m <= tm)) {
    months.push({ year: y, month: m });
    if (++m > 12) { m = 1; y++; }
  }
  return months;
}

// ─── roomAmounts 키 정규화 ─────────────────────────────────────
// '스터디룸A1' → 'A1'
function normalizeRoomAmounts(studyRoomRevenue) {
  const out = {};
  for (const [k, v] of Object.entries(studyRoomRevenue)) {
    const match = k.match(/스터디룸([A-Z]\d*)/);
    const key = match ? match[1] : k;
    out[key] = (out[key] || 0) + v;
  }
  return out;
}

// ─── 금액 포맷 ─────────────────────────────────────────────────
function fmt(n) { return Number(n || 0).toLocaleString('ko-KR') + '원'; }

// ─── 날짜 → 요일 ───────────────────────────────────────────────
const DOW_KO = ['일', '월', '화', '수', '목', '금', '토'];
function getDayOfWeek(dateStr) {
  return DOW_KO[new Date(dateStr + 'T00:00:00+09:00').getDay()];
}
function getIsWeekend(dateStr) {
  const dow = new Date(dateStr + 'T00:00:00+09:00').getDay();
  return (dow === 0 || dow === 6) ? 1 : 0;
}

// ─── CSV 생성 ──────────────────────────────────────────────────
function exportCsv(from, to) {
  const fromDate = from + '-01';
  const toDate   = to   + '-31'; // 말일은 대략
  const rows = getDailySummariesInRange(fromDate, toDate);

  const header = 'date,day_of_week,is_weekend,study_cafe,room_a1,room_a2,room_b,study_room_total,total';
  const lines  = [header];

  for (const row of rows) {
    const roomAmounts = row.roomAmounts || {};
    const a1    = roomAmounts['A1'] || 0;
    const a2    = roomAmounts['A2'] || 0;
    const b     = roomAmounts['B']  || 0;
    const srTotal = a1 + a2 + b;
    const total = (row.general_revenue || 0) + srTotal;

    lines.push([
      row.date,
      getDayOfWeek(row.date),
      getIsWeekend(row.date),
      row.general_revenue || 0,
      a1, a2, b,
      srTotal,
      total,
    ].join(','));
  }

  fs.writeFileSync(CSV_PATH, lines.join('\n') + '\n', 'utf-8');
  log(`\n📊 예측용 CSV 저장: ${CSV_PATH}  (${rows.length}행)`);
  log('   컬럼: date, day_of_week, is_weekend, study_cafe, room_a1, room_a2, room_b, study_room_total, total');
}

// ─── 메인 ──────────────────────────────────────────────────────
async function main() {
  log(`\n🗂️  픽코 매출 이력 채우기: ${FROM_MONTH} ~ ${TO_MONTH}${DRY_RUN ? '  [DRY-RUN — DB 저장 없음]' : ''}`);
  log('   저장 구조: 스터디카페(일반이용) / 스터디룸(A1·A2·B) 분리\n');

  const months = monthsInRange(FROM_MONTH, TO_MONTH);
  log(`처리 월: ${months.length}개 (${months.map(({ year, month }) =>
    `${year}-${String(month).padStart(2, '0')}`).join(', ')})\n`);

  let totalSaved = 0, totalZero = 0, totalErrors = 0;
  let browser;

  try {
    browser = await puppeteer.launch(getPickkoLaunchOptions());
    const pages = await browser.pages();
    const page  = pages[0] || await browser.newPage();
    page.setDefaultTimeout(30000);
    setupDialogHandler(page, log);

    // ── 로그인 ──────────────────────────────────────────────
    log('[로그인] 픽코 로그인 시작');
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log('✅ 로그인 완료\n');

    for (const { year, month } of months) {
      const monthStr = `${year}-${String(month).padStart(2, '0')}`;
      log(`━━━ ${monthStr} ━━━`);

      // 월별 날짜 목록 조회
      let monthRows;
      try {
        monthRows = await fetchMonthlyRevenue(page, year, month);
        log(`  ${monthRows.length}개 날짜 데이터\n`);
      } catch (err) {
        log(`  ❌ 월별 조회 실패: ${err.message}`);
        totalErrors++;
        continue;
      }

      for (const { date, netRevenue } of monthRows) {
        const dow = getDayOfWeek(date);

        // 매출 0원 → 상세 파싱 스킵, 0원으로 저장
        if (netRevenue === 0) {
          if (!DRY_RUN) {
            upsertDailySummary(date, {
              totalAmount: 0, roomAmounts: {}, entriesCount: 0,
              pickkoTotal: 0, pickkoStudyRoom: 0, generalRevenue: 0,
            });
          }
          log(`  ${date} (${dow}): 0원`);
          totalZero++;
          continue;
        }

        // 매출 있는 날짜 → 일별 상세 파싱
        try {
          await delay(800); // 서버 부하 방지
          const detail         = await fetchDailyDetail(page, date);
          const studyRoomTotal = Object.values(detail.studyRoomRevenue).reduce((s, v) => s + v, 0);
          const roomAmounts    = normalizeRoomAmounts(detail.studyRoomRevenue);

          const roomBreakdown = ['A1', 'A2', 'B']
            .filter(r => roomAmounts[r])
            .map(r => `${r} ${fmt(roomAmounts[r])}`)
            .join(' / ') || '-';

          log(`  ${date} (${dow}): ` +
              `스터디카페 ${fmt(detail.generalRevenue)}  ` +
              `스터디룸 [${roomBreakdown}]  ` +
              `합계 ${fmt(detail.totalRevenue)}  ` +
              `(${detail.transactions.length}건)`);

          if (!DRY_RUN) {
            upsertDailySummary(date, {
              totalAmount:     studyRoomTotal,
              roomAmounts,
              entriesCount:    detail.transactions.length,
              pickkoTotal:     detail.totalRevenue,
              pickkoStudyRoom: studyRoomTotal,
              generalRevenue:  detail.generalRevenue,
            });
          }
          totalSaved++;
        } catch (err) {
          log(`  ❌ ${date} 상세 파싱 실패: ${err.message}`);
          totalErrors++;
        }
      }

      await delay(1200); // 월 전환 대기
    }

  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }

  log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  log(`✅ 완료  매출 저장: ${totalSaved}건  0원: ${totalZero}건  오류: ${totalErrors}건`);

  if (!DRY_RUN) {
    exportCsv(FROM_MONTH, TO_MONTH);
  } else {
    log('⚠️  DRY-RUN — DB에 저장되지 않았습니다. --dry-run 제거 후 재실행하세요.');
  }
}

main().catch(err => {
  log(`❌ 치명 오류: ${err.message}\n${err.stack}`);
  process.exit(1);
});
