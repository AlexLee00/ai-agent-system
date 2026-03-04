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
const { publishToMainBot } = require('../../lib/mainbot-client');
const {
  getLatestUnconfirmedSummary,
  confirmDailySummary,
  getRoomRevenueSummary,
} = require('../../lib/db');

function formatAmount(amount) {
  return Number(amount || 0).toLocaleString('ko-KR') + '원';
}

function formatDateHeader(dateStr) {
  const d = new Date(dateStr + 'T00:00:00+09:00');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const dayNames = ['일', '월', '화', '수', '목', '금', '토'];
  return `${mm}/${dd} (${dayNames[d.getDay()]})`;
}

async function main() {
  log('\n💳 매출 컨펌 처리 시작');

  // 1. 미컨펌 요약 조회
  const pending = getLatestUnconfirmedSummary();

  if (!pending) {
    const msg = '✅ 컨펌할 매출 내역이 없습니다.\n(이미 모두 확정됐거나 아직 보고된 내역이 없습니다)';
    log(msg);
    publishToMainBot({ from_bot: 'ska', event_type: 'report', alert_level: 1, message: msg });
    console.log(JSON.stringify({ ok: false, reason: 'no_pending' }));
    return;
  }

  log(`  대상: ${pending.date} | ${pending.total_amount}원 | ${pending.entries_count}건`);

  // 2. 컨펌 처리 (daily_summary → room_revenue)
  const result = confirmDailySummary(pending.date);
  if (!result) {
    const msg = `❌ 컨펌 처리 실패: ${pending.date}`;
    log(msg);
    publishToMainBot({ from_bot: 'ska', event_type: 'system_error', alert_level: 3, message: msg });
    console.log(JSON.stringify({ ok: false, reason: 'confirm_failed' }));
    return;
  }

  log(`  ✅ 컨펌 완료: ${result.date}`);

  // 3. 텔레그램 컨펌 완료 메시지
  const dateHeader = formatDateHeader(result.date);
  // 일반이용 포함 전체 매출 항목
  const allAmounts = { ...result.roomAmounts };
  if (result.generalRevenue > 0) {
    allAmounts['일반이용'] = result.generalRevenue;
  }
  const roomLines = Object.entries(allAmounts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([room, amt]) => `  ${room}: ${formatAmount(amt)}`)
    .join('\n');

  const grandTotal = result.totalAmount + (result.generalRevenue || 0);
  let msg = `✅ 매출 확정 — ${dateHeader}\n\n`;
  msg += `${roomLines}\n`;
  msg += `  합계: ${formatAmount(grandTotal)}\n`;

  // 4. 누적 매출 요약 (room_revenue 전체)
  const revSummary = getRoomRevenueSummary();
  if (revSummary.length > 0) {
    msg += `\n📊 스터디룸 누적 매출:\n`;
    for (const r of revSummary) {
      msg += `  ${r.room}: ${formatAmount(r.total_amount)} (${r.days}일)\n`;
    }
  }

  log('\n' + msg);
  publishToMainBot({ from_bot: 'ska', event_type: 'report', alert_level: 1, message: msg });

  console.log(JSON.stringify({
    ok:         true,
    date:       result.date,
    totalAmount: result.totalAmount,
    roomAmounts: result.roomAmounts,
  }));
}

main().catch(err => {
  log(`❌ 치명 오류: ${err.message}`);
  publishToMainBot({ from_bot: 'ska', event_type: 'system_error', alert_level: 3, message: `❌ 매출 컨펌 오류: ${err.message}` });
  console.log(JSON.stringify({ ok: false, reason: err.message }));
  process.exit(1);
});
