#!/usr/bin/env node
'use strict';

/**
 * manual-block-followup-report.js — manual 등록 후속 네이버 차단 점검 리포트
 *
 * 사용법:
 *   node manual/reports/manual-block-followup-report.js
 *   node manual/reports/manual-block-followup-report.js --from=2026-03-21
 *   node manual/reports/manual-block-followup-report.js --only-open
 *
 * 출력 (stdout JSON):
 *   { success: true, count: N, openCount: M, message, rows }
 */

const pgPool = require('../../../../packages/core/lib/pg-pool');
const { parseArgs } = require('../../lib/args');
const { outputResult, fail } = require('../../lib/cli');

const SCHEMA = 'reservation';
const ARGS = parseArgs(process.argv);
const fromDate = ARGS.from || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const onlyOpen = Boolean(ARGS['only-open'] || ARGS.onlyOpen);

function formatRow(row) {
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

  const rows = await pgPool.query(SCHEMA, `
    SELECT
      r.id,
      r.date,
      r.start_time,
      r.end_time,
      r.room,
      r.status,
      r.pickko_status,
      r.phone,
      kb.id AS kiosk_block_id,
      kb.naver_blocked,
      kb.blocked_at,
      kb.last_block_attempt_at,
      kb.last_block_result,
      kb.last_block_reason,
      kb.block_retry_count,
      kb.first_seen_at
    FROM reservations r
    LEFT JOIN kiosk_blocks kb
      ON kb.phone_raw_enc IS NOT NULL
     AND kb.date = r.date
     AND kb.start_time = r.start_time
     AND (kb.room IS NULL OR r.room IS NULL OR kb.room = r.room)
    WHERE r.pickko_status IN ('manual', 'manual_retry')
      AND r.status = 'completed'
      AND r.date >= $1
    ORDER BY r.date ASC, r.start_time ASC, r.updated_at DESC NULLS LAST
  `, [fromDate]);

  const openRows = rows.filter((row) => !row.kiosk_block_id || Number(row.naver_blocked || 0) !== 1);
  const selectedRows = onlyOpen ? openRows : rows;

  const header = [
    `📋 manual 등록 후속 네이버 차단 리포트`,
    `기준일: ${fromDate}`,
    `전체 ${rows.length}건 / 미완료 ${openRows.length}건`,
  ];

  const lines = selectedRows.length > 0
    ? selectedRows.map(formatRow)
    : ['✅ 조건에 맞는 대상 없음'];

  outputResult({
    success: true,
    count: rows.length,
    openCount: openRows.length,
    rows: selectedRows,
    message: [...header, '', ...lines].join('\n'),
  });
}

main().catch((error) => {
  fail(`manual follow-up 리포트 조회 실패: ${error.message}`);
});
