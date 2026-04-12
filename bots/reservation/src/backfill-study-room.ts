#!/usr/bin/env node
// @ts-nocheck
/**
 * backfill-study-room.ts
 * daily_summary.total_amount=0 인 날짜들 중 일반매출 또는 엔트리가 남아 있는 날을 찾아
 * 픽코 스터디룸 결제완료 예약을 다시 조회한 뒤 room_amounts_json / pickko_study_room / total_amount 를 보정한다.
 */
'use strict';

const puppeteer = require('puppeteer');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { loadSecrets } = require('../lib/secrets');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../lib/browser');
const { loginToPickko, fetchPickkoEntries } = require('../lib/pickko');
const { delay, log } = require('../lib/utils');
const { getDailySummary, upsertDailySummary } = require('../lib/db');
const { buildRoomAmountsFromEntries } = require('../lib/study-room-pricing');

const SECRETS = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;
const SCHEMA = 'reservation';

async function listBackfillDates() {
  const rows = await pgPool.query(SCHEMA, `
    SELECT date::text AS date
    FROM daily_summary
    WHERE COALESCE(total_amount, 0) = 0
      AND (
        COALESCE(general_revenue, 0) > 0
        OR COALESCE(entries_count, 0) > 0
        OR COALESCE(pickko_study_room, 0) = 0
      )
    ORDER BY date::date DESC
  `);
  return rows.map((row) => row.date).filter(Boolean);
}

async function buildStudyRoomSummary(page, date) {
  const { entries, fetchOk } = await fetchPickkoEntries(page, date, {
    statusKeyword: '결제완료',
    endDate: date,
    sortBy: 'sd_start',
  });

  if (!fetchOk || entries.length === 0) {
    return {
      fetchOk,
      entries,
      roomAmounts: {},
      studyRoomTotal: 0,
      entryCount: 0,
    };
  }

  const roomAmounts = buildRoomAmountsFromEntries(entries);
  const studyRoomTotal = Object.values(roomAmounts).reduce((sum, amount) => sum + Number(amount || 0), 0);
  return {
    fetchOk,
    entries,
    roomAmounts,
    studyRoomTotal,
    entryCount: entries.length,
  };
}

function formatRoomBreakdown(roomAmounts) {
  return Object.entries(roomAmounts)
    .map(([room, amount]) => `${room}:${(Number(amount || 0) / 1000).toFixed(0)}K`)
    .join(' ');
}

async function main() {
  const dates = await listBackfillDates();
  if (dates.length === 0) {
    log('📋 보정 대상 날짜가 없습니다.');
    return;
  }

  log(`\n📋 채울 날짜: ${dates.length}개`);
  log(`  기간: ${dates[dates.length - 1]} ~ ${dates[0]}\n`);

  const browser = await puppeteer.launch(getPickkoLaunchOptions());
  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  page.setDefaultTimeout(30000);
  setupDialogHandler(page, log);

  try {
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log('✅ 로그인 완료\n');

    let updated = 0;
    let skipped = 0;
    let errors = 0;

    for (let i = 0; i < dates.length; i += 1) {
      const date = dates[i];
      process.stdout.write(`[${i + 1}/${dates.length}] ${date} ... `);

      try {
        const summary = await getDailySummary(date);
        const result = await buildStudyRoomSummary(page, date);

        if (!result.fetchOk || result.entryCount === 0 || result.studyRoomTotal === 0) {
          process.stdout.write(`${result.entryCount}건 (스킵)\n`);
          skipped += 1;
          continue;
        }

        const generalRevenue = Number(summary?.generalRevenue || summary?.general_revenue || 0);
        const entriesCount = Number(summary?.entries_count || summary?.entriesCount || result.entryCount || 0);
        const totalAmount = generalRevenue + result.studyRoomTotal;

        await upsertDailySummary(date, {
          totalAmount,
          roomAmounts: result.roomAmounts,
          entriesCount,
          pickkoStudyRoom: result.studyRoomTotal,
          generalRevenue,
        });

        const roomStr = formatRoomBreakdown(result.roomAmounts);
        process.stdout.write(`${result.entryCount}건 → ${totalAmount.toLocaleString()}원 [${roomStr}]\n`);
        updated += 1;
      } catch (error) {
        process.stdout.write(`❌ ${error.message}\n`);
        errors += 1;
      }
    }

    log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log(`✅ 완료: ${updated}건 업데이트 | 스킵 ${skipped}건 | 오류 ${errors}건`);
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  log(`❌ 치명 오류: ${error.message}`);
  process.exit(1);
});
