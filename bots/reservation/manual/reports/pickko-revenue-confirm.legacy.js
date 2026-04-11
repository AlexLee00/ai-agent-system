#!/usr/bin/env node

/**
 * pickko-revenue-confirm.js — 매출 컨펌 처리
 *
 * 사장님이 "매출 컨펌"이라고 텔레그램에 전송하면 스카가 이 스크립트를 실행.
 * 가장 최근 미컨펌 daily_summary를 찾아 room_revenue에 누적하고 확정.
 *
 * 실행: node src/pickko-revenue-confirm.js
 * 출력: JSON stdout (스카 봇이 파싱) + 텔레그램 직접 발송
 */

const { log } = require('../../lib/utils');
const { publishReservationAlert } = require('../../lib/alert-client');
const {
  formatAmount,
  formatDateHeader,
  buildRevenueConfirmMessage,
} = require('../../lib/report-followup-helpers');
const {
  getLatestUnconfirmedSummary,
  confirmDailySummary,
  getRoomRevenueSummary,
} = require('../../lib/db');

async function main() {
  log('\n💳 매출 컨펌 처리 시작');

  // 1. 미컨펌 요약 조회
  const pending = await getLatestUnconfirmedSummary();

  if (!pending) {
    const msg = '✅ 컨펌할 매출 내역이 없습니다.\n(이미 모두 확정됐거나 아직 보고된 내역이 없습니다)';
    log(msg);
    publishReservationAlert({ from_bot: 'ska', event_type: 'report', alert_level: 1, message: msg });
    console.log(JSON.stringify({ ok: false, reason: 'no_pending' }));
    return;
  }

  log(`  대상: ${pending.date} | ${pending.total_amount}원 | ${pending.entries_count}건`);

  // 2. 컨펌 처리 (daily_summary → room_revenue)
  const result = await confirmDailySummary(pending.date);
  if (!result) {
    const msg = `❌ 컨펌 처리 실패: ${pending.date}`;
    log(msg);
    publishReservationAlert({ from_bot: 'ska', event_type: 'system_error', alert_level: 3, message: msg });
    console.log(JSON.stringify({ ok: false, reason: 'confirm_failed' }));
    return;
  }

  log(`  ✅ 컨펌 완료: ${result.date}`);

  // 3. 텔레그램 컨펌 완료 메시지
  // 4. 누적 매출 요약 (room_revenue 전체)
  const revSummary = await getRoomRevenueSummary();
  const msg = buildRevenueConfirmMessage(result, revSummary);

  log('\n' + msg);
  publishReservationAlert({ from_bot: 'ska', event_type: 'report', alert_level: 1, message: msg });

  console.log(JSON.stringify({
    ok:         true,
    date:       result.date,
    totalAmount: result.totalAmount,
    roomAmounts: result.roomAmounts,
  }));
}

main().catch(err => {
  log(`❌ 치명 오류: ${err.message}`);
  publishReservationAlert({ from_bot: 'ska', event_type: 'system_error', alert_level: 3, message: `❌ 매출 컨펌 오류: ${err.message}` });
  console.log(JSON.stringify({ ok: false, reason: err.message }));
  process.exit(1);
});
