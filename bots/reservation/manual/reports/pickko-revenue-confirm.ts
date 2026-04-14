#!/usr/bin/env node

const { log } = require('../../lib/utils');
const { publishReservationAlert } = require('../../lib/alert-client');
const { createAgentMemory } = require('../../../../packages/core/lib/agent-memory');
const {
  buildRevenueConfirmMessage,
} = require('../../lib/report-followup-helpers');
const {
  getLatestUnconfirmedSummary,
  confirmDailySummary,
  getRoomRevenueSummary,
} = require('../../lib/db');
const revenueConfirmMemory = createAgentMemory({ agentId: 'reservation.pickko-revenue-confirm', team: 'reservation' });

function buildRevenueMemoryQuery(kind: string, pending: any, result: any) {
  return [
    'reservation pickko revenue confirm',
    kind,
    pending?.date || result?.date || 'unknown-date',
    pending?.entries_count != null ? `entries-${pending.entries_count}` : null,
  ].filter(Boolean).join(' ');
}

async function main() {
  log('\n💳 매출 컨펌 처리 시작');

  const pending = await getLatestUnconfirmedSummary();
  if (!pending) {
    const msg = '✅ 컨펌할 매출 내역이 없습니다.\n(이미 모두 확정됐거나 아직 보고된 내역이 없습니다)';
    const memoryQuery = buildRevenueMemoryQuery('no_pending', pending, null);
    const episodicHint = await revenueConfirmMemory.recallCountHint(memoryQuery, {
      type: 'episodic',
      limit: 2,
      threshold: 0.33,
      title: '최근 유사 컨펌',
      separator: 'pipe',
      metadataKey: 'kind',
      labels: {
        no_pending: '없음',
        confirmed: '확정',
        failure: '실패',
      },
      order: ['no_pending', 'confirmed', 'failure'],
    }).catch(() => '');
    const semanticHint = await revenueConfirmMemory.recallHint(`${memoryQuery} consolidated revenue confirm pattern`, {
      type: 'semantic',
      limit: 2,
      threshold: 0.28,
      title: '최근 통합 패턴',
      separator: 'newline',
    }).catch(() => '');
    const finalMessage = `${msg}${episodicHint}${semanticHint}`;
    log(msg);
    publishReservationAlert({ from_bot: 'ska', event_type: 'report', alert_level: 1, message: finalMessage });
    await revenueConfirmMemory.remember(msg, 'episodic', {
      importance: 0.58,
      expiresIn: 1000 * 60 * 60 * 24 * 30,
      metadata: { kind: 'no_pending' },
    }).catch(() => {});
    await revenueConfirmMemory.consolidate({ olderThanDays: 14, limit: 10 }).catch(() => {});
    console.log(JSON.stringify({ ok: false, reason: 'no_pending' }));
    return;
  }

  log(`  대상: ${pending.date} | ${pending.total_amount}원 | ${pending.entries_count}건`);

  const result = await confirmDailySummary(pending.date);
  if (!result) {
    const msg = `❌ 컨펌 처리 실패: ${pending.date}`;
    const memoryQuery = buildRevenueMemoryQuery('failure', pending, null);
    const episodicHint = await revenueConfirmMemory.recallCountHint(memoryQuery, {
      type: 'episodic',
      limit: 2,
      threshold: 0.33,
      title: '최근 유사 컨펌',
      separator: 'pipe',
      metadataKey: 'kind',
      labels: {
        failure: '실패',
        confirmed: '확정',
      },
      order: ['failure', 'confirmed'],
    }).catch(() => '');
    const semanticHint = await revenueConfirmMemory.recallHint(`${memoryQuery} consolidated revenue confirm pattern`, {
      type: 'semantic',
      limit: 2,
      threshold: 0.28,
      title: '최근 통합 패턴',
      separator: 'newline',
    }).catch(() => '');
    const finalMessage = `${msg}${episodicHint}${semanticHint}`;
    log(msg);
    publishReservationAlert({ from_bot: 'ska', event_type: 'system_error', alert_level: 3, message: finalMessage });
    await revenueConfirmMemory.remember(msg, 'episodic', {
      importance: 0.82,
      expiresIn: 1000 * 60 * 60 * 24 * 30,
      metadata: { kind: 'failure', date: pending.date, entriesCount: pending.entries_count || 0 },
    }).catch(() => {});
    await revenueConfirmMemory.consolidate({ olderThanDays: 14, limit: 10 }).catch(() => {});
    console.log(JSON.stringify({ ok: false, reason: 'confirm_failed' }));
    return;
  }

  log(`  ✅ 컨펌 완료: ${result.date}`);

  const revSummary = await getRoomRevenueSummary();
  const msg = buildRevenueConfirmMessage(result, revSummary);
  const memoryQuery = buildRevenueMemoryQuery('confirmed', pending, result);
  const episodicHint = await revenueConfirmMemory.recallCountHint(memoryQuery, {
    type: 'episodic',
    limit: 2,
    threshold: 0.33,
    title: '최근 유사 컨펌',
    separator: 'pipe',
    metadataKey: 'kind',
    labels: {
      confirmed: '확정',
      failure: '실패',
    },
    order: ['confirmed', 'failure'],
  }).catch(() => '');
  const semanticHint = await revenueConfirmMemory.recallHint(`${memoryQuery} consolidated revenue confirm pattern`, {
    type: 'semantic',
    limit: 2,
    threshold: 0.28,
    title: '최근 통합 패턴',
    separator: 'newline',
  }).catch(() => '');
  const finalMessage = `${msg}${episodicHint}${semanticHint}`;

  log('\n' + msg);
  publishReservationAlert({ from_bot: 'ska', event_type: 'report', alert_level: 1, message: finalMessage });
  await revenueConfirmMemory.remember(msg, 'episodic', {
    importance: 0.7,
    expiresIn: 1000 * 60 * 60 * 24 * 30,
    metadata: {
      kind: 'confirmed',
      date: result.date,
      totalAmount: result.totalAmount,
    },
  }).catch(() => {});
  await revenueConfirmMemory.consolidate({ olderThanDays: 14, limit: 10 }).catch(() => {});

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
  const baseMessage = `❌ 매출 컨펌 오류: ${err.message}`;
  publishReservationAlert({
    from_bot: 'ska',
    event_type: 'system_error',
    alert_level: 3,
    message: baseMessage,
  });
  revenueConfirmMemory.remember(baseMessage, 'episodic', {
    importance: 0.84,
    expiresIn: 1000 * 60 * 60 * 24 * 30,
    metadata: { kind: 'failure', fatal: true },
  })
    .then(() => revenueConfirmMemory.consolidate({ olderThanDays: 14, limit: 10 }))
    .catch(() => {})
    .finally(() => {
      console.log(JSON.stringify({ ok: false, reason: err.message }));
      process.exit(1);
    });
});
