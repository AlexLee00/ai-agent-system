#!/usr/bin/env node
'use strict';

/**
 * manual-block-followup-resolve.js — manual 등록 후속 네이버 차단 수동 처리 결과 반영
 */

const pgPool = require('../../../../packages/core/lib/pg-pool');
const { parseArgs } = require('../../lib/args');
const { outputResult, fail } = require('../../lib/cli');
const { upsertKioskBlock, recordKioskBlockAttempt } = require('../../lib/db');

const SCHEMA = 'reservation';
const ARGS = parseArgs(process.argv);

type TargetRow = {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  room: string | null;
  status: string;
  pickko_status: string;
  phone: string | null;
  kiosk_block_id: string | null;
  naver_blocked: number | boolean | null;
  blocked_at: string | null;
};

type TouchedRow = {
  phone: string | null;
  date: string;
  start: string;
  end: string;
  room: string | null;
  mode: 'dry_run' | 'updated';
};

function normalizePhone(raw: unknown) {
  return String(raw || '').replace(/\D+/g, '');
}

function nowKST() {
  return `${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(' ', 'T')}+09:00`;
}

async function findOpenRows(fromDate: string): Promise<TargetRow[]> {
  return pgPool.query(SCHEMA, `
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
      kb.blocked_at
    FROM reservations r
    LEFT JOIN kiosk_blocks kb
      ON kb.phone_raw_enc IS NOT NULL
     AND kb.date = r.date
     AND kb.start_time = r.start_time
     AND (kb.room IS NULL OR r.room IS NULL OR kb.room = r.room)
    WHERE r.pickko_status IN ('manual', 'manual_retry')
      AND r.status = 'completed'
      AND r.date >= $1
      AND (kb.id IS NULL OR kb.naver_blocked <> 1)
    ORDER BY r.date ASC, r.start_time ASC, r.updated_at DESC NULLS LAST
  `, [fromDate]);
}

async function findTargetRows(): Promise<TargetRow[]> {
  const allOpen = Boolean(ARGS['all-open'] || ARGS.allOpen);
  const fromDate = ARGS.from || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });

  if (allOpen) {
    return findOpenRows(fromDate);
  }

  const phone = normalizePhone(ARGS.phone);
  const date = ARGS.date;
  const start = ARGS.start;
  const room = ARGS.room || null;

  if (!phone || !date || !start) {
    fail('개별 반영은 --phone --date --start 가 필요합니다. 또는 --all-open --from=YYYY-MM-DD 를 사용하세요.');
  }

  return pgPool.query(SCHEMA, `
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
      kb.blocked_at
    FROM reservations r
    LEFT JOIN kiosk_blocks kb
      ON kb.phone_raw_enc IS NOT NULL
     AND kb.date = r.date
     AND kb.start_time = r.start_time
     AND (kb.room IS NULL OR r.room IS NULL OR kb.room = r.room)
    WHERE replace(r.phone, '-', '') = $1
      AND r.date = $2
      AND r.start_time = $3
      AND ($4::text IS NULL OR r.room = $4)
      AND r.pickko_status IN ('manual', 'manual_retry')
      AND r.status = 'completed'
    ORDER BY r.updated_at DESC NULLS LAST
  `, [phone, date, start, room]);
}

async function main() {
  const dryRun = Boolean(ARGS['dry-run'] || ARGS.dryRun);
  const rows = await findTargetRows();
  if (rows.length === 0) {
    outputResult({ success: true, updated: 0, message: '반영할 manual 후속 차단 대상이 없습니다.' });
    return;
  }

  const appliedAt = nowKST();
  const touched: TouchedRow[] = [];

  for (const row of rows) {
    const phoneRaw = normalizePhone(row.phone);
    const payload = {
      name: null,
      date: row.date,
      start: row.start_time,
      end: row.end_time,
      room: row.room,
      amount: 0,
      naverBlocked: true,
      firstSeenAt: null,
      blockedAt: row.blocked_at || appliedAt,
      lastBlockAttemptAt: appliedAt,
      lastBlockResult: 'manually_confirmed',
      lastBlockReason: 'operator_confirmed_naver_blocked',
      blockRetryCount: 0,
    };

    if (!dryRun) {
      await upsertKioskBlock(phoneRaw, row.date, row.start_time, payload);
      await recordKioskBlockAttempt(phoneRaw, row.date, row.start_time, {
        ...payload,
        incrementRetry: false,
      });
    }

    touched.push({
      phone: row.phone,
      date: row.date,
      start: row.start_time,
      end: row.end_time,
      room: row.room,
      mode: dryRun ? 'dry_run' : 'updated',
    });
  }

  const lines = touched.map((item) =>
    `✅ ${item.date} ${item.start}~${item.end} ${item.room || '-'} (${item.phone}) ${item.mode === 'dry_run' ? '[dry-run]' : ''}`.trim(),
  );

  outputResult({
    success: true,
    updated: touched.length,
    dryRun,
    rows: touched,
    message: [
      dryRun ? '🧪 manual 후속 차단 원장 반영 dry-run' : '✅ manual 후속 차단 원장 반영 완료',
      `${touched.length}건`,
      '',
      ...lines,
    ].join('\n'),
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  fail(`manual 후속 차단 원장 반영 실패: ${message}`);
});
