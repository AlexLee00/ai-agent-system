#!/usr/bin/env node

const { log } = require('../../lib/utils');
const { publishReservationAlert } = require('../../lib/alert-client');
const {
  buildRevenueConfirmMessage,
} = require('../../lib/report-followup-helpers');
const {
  getLatestUnconfirmedSummary,
  confirmDailySummary,
  getRoomRevenueSummary,
} = require('../../lib/db');

async function main() {
  log('\n💳 매출 컨펌 처리 시작');

  const pending = await getLatestUnconfirmedSummary();
  if (!pending) {
    const msg = '✅ 컨펌할 매출 내역이 없습니다.\n(이미 모두 확정됐거나 아직 보고된 내역이 없습니다)';
    log(msg);
    publishReservationAlert({ from_bot: 'ska', event_type: 'report', alert_level: 1, message: msg });
    console.log(JSON.stringify({ ok: false, reason: 'no_pending' }));
    return;
  }

  log(`  대상: ${pending.date} | ${pending.total_amount}원 | ${pending.entries_count}건`);

  const result = await confirmDailySummary(pending.date);
  if (!result) {
    const msg = `❌ 컨펌 처리 실패: ${pending.date}`;
    log(msg);
    publishReservationAlert({ from_bot: 'ska', event_type: 'system_error', alert_level: 3, message: msg });
    console.log(JSON.stringify({ ok: false, reason: 'confirm_failed' }));
    return;
  }

  log(`  ✅ 컨펌 완료: ${result.date}`);

  const revSummary = await getRoomRevenueSummary();
  const msg = buildRevenueConfirmMessage(result, revSummary);

  log('\n' + msg);
  publishReservationAlert({ from_bot: 'ska', event_type: 'report', alert_level: 1, message: msg });

  console.log(JSON.stringify({
    ok: true,
    date: result.date,
    totalAmount: result.totalAmount,
    roomAmounts: result.roomAmounts,
  }));
}

module.exports = { main };

main().catch((err: any) => {
  log(`❌ 치명 오류: ${err.message}`);
  publishReservationAlert({
    from_bot: 'ska',
    event_type: 'system_error',
    alert_level: 3,
    message: `❌ 매출 컨펌 오류: ${err.message}`,
  });
  console.log(JSON.stringify({ ok: false, reason: err.message }));
  process.exit(1);
});
