#!/usr/bin/env node
/**
 * backfill-study-room.js
 * daily_summary.total_amount=0인 날짜에 대해 픽코에서 스터디룸 예약 조회 →
 * 룸별 금액 합산 → DB 업데이트 (one-off 작업)
 */

const { getDb }           = require('../lib/db');
const { loadSecrets }     = require('../lib/secrets');
const { getPickkoLaunchOptions, setupDialogHandler } = require('../lib/browser');
const { loginToPickko, fetchPickkoEntries }           = require('../lib/pickko');
const { delay, log }      = require('../lib/utils');

const puppeteer = require('puppeteer');

const SECRETS   = loadSecrets();
const PICKKO_ID = SECRETS.pickko_id;
const PICKKO_PW = SECRETS.pickko_pw;

// 룸 이름 정규화: "스터디룸A1" 등 그대로 유지 (room_amounts_json 기존 형식 일치)
function normalizeRoom(raw) {
  const r = (raw || '').trim();
  if (/A1/i.test(r)) return '스터디룸A1';
  if (/A2/i.test(r)) return '스터디룸A2';
  if (/B룸|스터디룸B|\bB\b/i.test(r)) return '스터디룸B';
  return r; // 그 외 (일반이용 등은 포함 안 됨)
}

async function main() {
  const db = getDb();

  // 채울 날짜 목록 (total_amount=0 이고 일반매출 또는 엔트리가 남아 있는 날)
  const dates = db.prepare(
    'SELECT date FROM daily_summary WHERE total_amount = 0 AND (general_revenue > 0 OR entries_count > 0) ORDER BY date DESC'
  ).all().map(r => r.date);

  log(`\n📋 채울 날짜: ${dates.length}개`);
  log(`  기간: ${dates[dates.length - 1]} ~ ${dates[0]}\n`);

  // 픽코 브라우저 시작
  const browser = await puppeteer.launch(getPickkoLaunchOptions());
  const pages   = await browser.pages();
  const page    = pages[0] || await browser.newPage();
  page.setDefaultTimeout(30000);
  setupDialogHandler(page, log);

  try {
    await loginToPickko(page, PICKKO_ID, PICKKO_PW, delay);
    log(`✅ 로그인 완료\n`);

    let updated = 0, skipped = 0, errors = 0;

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      process.stdout.write(`[${i + 1}/${dates.length}] ${date} ... `);

      try {
        const { entries, fetchOk } = await fetchPickkoEntries(page, date, {
          statusKeyword: '결제완료',
          endDate: date,
          sortBy: 'sd_start',
        });

        if (!fetchOk || entries.length === 0) {
          process.stdout.write(`0건 (스킵)\n`);
          skipped++;
          continue;
        }

        // 룸별 합산
        const roomAmounts = {};
        let total = 0;
        for (const e of entries) {
          const room = normalizeRoom(e.room);
          if (!room) continue;
          roomAmounts[room] = (roomAmounts[room] || 0) + (e.amount || 0);
          total += e.amount || 0;
        }

        if (total === 0) {
          process.stdout.write(`${entries.length}건 금액합계 0 (스킵)\n`);
          skipped++;
          continue;
        }

        // DB 업데이트 (confirmed, general_revenue 등 기존 값 유지)
        db.prepare(`
          UPDATE daily_summary
          SET total_amount = ?, room_amounts_json = ?
          WHERE date = ?
        `).run(total, JSON.stringify(roomAmounts), date);

        const roomStr = Object.entries(roomAmounts)
          .map(([r, a]) => `${r.replace('스터디룸', '')}:${(a/1000).toFixed(0)}K`)
          .join(' ');
        process.stdout.write(`${entries.length}건 → ${total.toLocaleString()}원 [${roomStr}]\n`);
        updated++;

      } catch (err) {
        process.stdout.write(`❌ ${err.message}\n`);
        errors++;
      }
    }

    log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    log(`✅ 완료: ${updated}건 업데이트 | 스킵 ${skipped}건 | 오류 ${errors}건`);

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  log(`❌ 치명 오류: ${err.message}`);
  process.exit(1);
});
