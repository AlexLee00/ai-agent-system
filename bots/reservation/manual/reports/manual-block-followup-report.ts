#!/usr/bin/env node
'use strict';

/**
 * manual-block-followup-report.js — manual 등록 후속 네이버 차단 점검 리포트
 */

const pgPool = require('../../../../packages/core/lib/pg-pool');
const { parseArgs } = require('../../lib/args');
const { outputResult, fail } = require('../../lib/cli');
const { getKioskBlock, getBlockedKioskBlocks } = require('../../lib/db');
const { buildReservationCliInsight } = require('../../lib/cli-insight');

const SCHEMA = 'reservation';
const ARGS = parseArgs(process.argv);
const fromDate = ARGS.from || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const onlyOpen = Boolean(ARGS['only-open'] || ARGS.onlyOpen);

type ReservationRow = {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  room: string | null;
  status: string;
  pickko_status: string;
  phone: string | null;
};

type FollowupReportRow = ReservationRow & {
  kiosk_block_id: string | null;
  naver_blocked: number | null;
  blocked_at: string | null;
  last_block_attempt_at: string | null;
  last_block_result: string | null;
  last_block_reason: string | null;
  block_retry_count: number;
  first_seen_at: string | null;
  corrected_slot?: boolean;
};

function normalizePhone(value: unknown) {
  return String(value || '').replace(/\D+/g, '');
}

function formatRow(row: FollowupReportRow) {
  const phone = row.phone ? ` (${row.phone})` : '';
  const base = `${row.date} ${row.start_time}~${row.end_time} ${row.room || '-'} ${phone}`.trim();

  if (!row.kiosk_block_id) {
    return `🔴 ${base} — kiosk_blocks row 없음`;
  }

  if (Number(row.naver_blocked) === 1) {
    return `✅ ${base} — 차단 완료 (${row.blocked_at || 'blocked_at 없음'})`;
  }

  const parts = [`🟠 ${base} — 차단 미완료`];
  if (row.last_block_result) parts.push(`결과=${row.last_block_result}`);
  if (row.last_block_reason) parts.push(`사유=${row.last_block_reason}`);
  parts.push(`retry=${Number(row.block_retry_count || 0)}`);
  return parts.join(' / ');
}

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    fail(`--from 형식 오류: ${fromDate} (예: 2026-03-21)`);
  }

  const reservationRows: ReservationRow[] = await pgPool.query(SCHEMA, `
    SELECT
      r.id,
      r.date,
      r.start_time,
      r.end_time,
      r.room,
      r.status,
      r.pickko_status,
      r.phone
    FROM reservations r
    WHERE r.pickko_status IN ('manual', 'manual_retry')
      AND r.status = 'completed'
      AND r.date >= $1
    ORDER BY r.date ASC, r.start_time ASC, r.updated_at DESC NULLS LAST
  `, [fromDate]);

  const rows: FollowupReportRow[] = await Promise.all(reservationRows.map(async (row) => {
    const phoneRaw = normalizePhone(row.phone);
    const kiosk = phoneRaw ? await getKioskBlock(phoneRaw, row.date, row.start_time, row.end_time, row.room) : null;
    return {
      ...row,
      kiosk_block_id: kiosk?.id || null,
      naver_blocked: kiosk ? (kiosk.naverBlocked ? 1 : 0) : null,
      blocked_at: kiosk?.blockedAt || null,
      last_block_attempt_at: kiosk?.lastBlockAttemptAt || null,
      last_block_result: kiosk?.lastBlockResult || null,
      last_block_reason: kiosk?.lastBlockReason || null,
      block_retry_count: kiosk?.blockRetryCount || 0,
      first_seen_at: kiosk?.firstSeenAt || null,
    };
  }));

  const openRows = rows.filter((row) => !row.kiosk_block_id || Number(row.naver_blocked || 0) !== 1);
  const selectedRows = onlyOpen ? openRows : rows;

  const matchedKeys = new Set(rows.map((row) => `${normalizePhone(row.phone)}|${row.date}|${row.start_time}|${row.room || ''}`));
  const correctedRows: FollowupReportRow[] = (await getBlockedKioskBlocks())
    .filter((row) => row.date >= fromDate)
    .filter((row) => row.lastBlockReason === 'operator_confirmed_actual_slot')
    .filter((row) => !matchedKeys.has(`${normalizePhone(row.phoneRaw)}|${row.date}|${row.start}|${row.room || ''}`))
    .map((row) => ({
      id: `corrected|${row.date}|${row.start}|${row.room || ''}|${normalizePhone(row.phoneRaw)}`,
      date: row.date,
      start_time: row.start,
      end_time: row.end,
      room: row.room,
      status: 'corrected',
      pickko_status: 'operator_confirmed_actual_slot',
      phone: row.phoneRaw,
      kiosk_block_id: row.id,
      naver_blocked: row.naverBlocked ? 1 : 0,
      blocked_at: row.blockedAt,
      last_block_attempt_at: row.lastBlockAttemptAt,
      last_block_result: row.lastBlockResult,
      last_block_reason: row.lastBlockReason,
      block_retry_count: row.blockRetryCount,
      first_seen_at: row.firstSeenAt,
      corrected_slot: true,
    }));

  const header = [
    '📋 manual 등록 후속 네이버 차단 리포트',
    `기준일: ${fromDate}`,
    `전체 ${rows.length}건 / 미완료 ${openRows.length}건 / 정정 슬롯 ${correctedRows.length}건`,
  ];

  const lines = selectedRows.length > 0
    ? selectedRows.map(formatRow)
    : ['✅ 조건에 맞는 대상 없음'];

  const correctedLines = correctedRows.length > 0
    ? ['', '🛠 운영자 정정으로 확인된 실제 차단 슬롯', ...correctedRows.map((row) => `✅ ${row.date} ${row.start_time}~${row.end_time} ${row.room || '-'} (${row.phone}) — 실제 차단 슬롯 / 사유=${row.last_block_reason}`)]
    : [];
  const aiSummary = await buildReservationCliInsight({
    bot: 'manual-block-followup-report',
    requestType: 'manual-followup-report',
    title: 'manual 등록 후속 네이버 차단 리포트',
    data: {
      fromDate,
      onlyOpen,
      total: rows.length,
      openCount: openRows.length,
      correctedCount: correctedRows.length,
      missingRows: openRows.filter((row) => !row.kiosk_block_id).length,
      unblockedRows: openRows.filter((row) => row.kiosk_block_id && Number(row.naver_blocked || 0) !== 1).length,
    },
    fallback: openRows.length > 0
      ? `후속 차단 미완료 ${openRows.length}건이 있어 kiosk_blocks 누락과 차단 미완료 건을 먼저 나눠 보는 편이 좋습니다.`
      : `manual 등록 후속 차단은 모두 정리된 상태이며, 정정 슬롯 ${correctedRows.length}건만 참고하면 됩니다.`,
  });

  outputResult({
    success: true,
    count: rows.length,
    openCount: openRows.length,
    correctedCount: correctedRows.length,
    rows: selectedRows,
    correctedRows,
    aiSummary,
    message: [...header, '', ...lines, ...correctedLines].join('\n'),
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(`manual follow-up 리포트 조회 실패: ${message}`);
});
