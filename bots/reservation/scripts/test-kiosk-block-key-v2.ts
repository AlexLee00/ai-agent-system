#!/usr/bin/env node
'use strict';

/**
 * test-kiosk-block-key-v2.js — kiosk_blocks v2 키 재예약 충돌 회귀 테스트
 *
 * 목적:
 *   - 같은 phone/date/start 이지만 end가 다른 두 예약이 서로 다른 row로 저장되는지 확인
 *   - 테스트는 트랜잭션 안에서 실행하고 마지막에 rollback 한다 (운영 DB 비파괴)
 *
 * 사용법:
 *   node bots/reservation/scripts/test-kiosk-block-key-v2.js
 *   node bots/reservation/scripts/test-kiosk-block-key-v2.js --date=2026-04-15 --room=A1
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const { parseArgs } = require('../lib/args');
const { encrypt, hashKioskKey, hashKioskKeyLegacy } = require('../lib/crypto');

const SCHEMA = 'reservation';
const ARGS = parseArgs(process.argv);

const TEST_PHONE = String(ARGS.phone || '01099998888').replace(/\D+/g, '');
const TEST_NAME = ARGS.name || '재예약테스트';
const TEST_DATE = ARGS.date || '2026-04-15';
const TEST_ROOM = ARGS.room || 'A1';
const START = '09:00';
const LONG_END = '13:00';
const SHORT_END = '11:00';

type InsertParams = {
  id: string;
  phoneRawEnc: string;
  nameEnc: string;
  date: string;
  start: string;
  end: string;
  room: string;
  amount: number;
  naverBlocked: number;
  firstSeenAt: null;
  blockedAt: string | null;
  naverUnblockedAt: null;
  lastBlockAttemptAt: string;
  lastBlockResult: string;
  lastBlockReason: string;
  blockRetryCount: number;
};

type KioskBlockRow = {
  id: string;
  date: string;
  start_time: string;
  end_time: string;
  room: string | null;
  naver_blocked: number;
  last_block_result: string | null;
  last_block_reason: string | null;
};

function buildInsertParams(endTime: string, naverBlocked = true): InsertParams {
  return {
    id: hashKioskKey(TEST_PHONE, TEST_DATE, START, endTime, TEST_ROOM),
    phoneRawEnc: encrypt(TEST_PHONE),
    nameEnc: encrypt(TEST_NAME),
    date: TEST_DATE,
    start: START,
    end: endTime,
    room: TEST_ROOM,
    amount: 0,
    naverBlocked: naverBlocked ? 1 : 0,
    firstSeenAt: null,
    blockedAt: naverBlocked ? new Date().toISOString() : null,
    naverUnblockedAt: null,
    lastBlockAttemptAt: new Date().toISOString(),
    lastBlockResult: naverBlocked ? 'test_blocked' : 'test_unblocked',
    lastBlockReason: 'test_kiosk_block_key_v2',
    blockRetryCount: 0,
  };
}

async function main() {
  const pool = pgPool.getPool(SCHEMA);
  const client = await pool.connect();
  try {
    await client.query(`SET search_path = ${SCHEMA}, public`);
    await client.query('BEGIN');

    const longBooking = buildInsertParams(LONG_END, false);
    const shortBooking = buildInsertParams(SHORT_END, true);

    for (const row of [longBooking, shortBooking]) {
      await client.query(`
        INSERT INTO kiosk_blocks
          (id, phone_raw_enc, name_enc, date, start_time, end_time, room,
           amount, naver_blocked, first_seen_at, blocked_at, naver_unblocked_at,
           last_block_attempt_at, last_block_result, last_block_reason, block_retry_count)
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      `, [
        row.id,
        row.phoneRawEnc,
        row.nameEnc,
        row.date,
        row.start,
        row.end,
        row.room,
        row.amount,
        row.naverBlocked,
        row.firstSeenAt,
        row.blockedAt,
        row.naverUnblockedAt,
        row.lastBlockAttemptAt,
        row.lastBlockResult,
        row.lastBlockReason,
        row.blockRetryCount,
      ]);
    }

    const rows: KioskBlockRow[] = (await client.query(`
      SELECT id, date, start_time, end_time, room, naver_blocked, last_block_result, last_block_reason
      FROM kiosk_blocks
      WHERE id = ANY($1)
      ORDER BY end_time
    `, [[longBooking.id, shortBooking.id]])).rows;

    const summary = {
      success: rows.length === 2,
      scenario: {
        phone: TEST_PHONE,
        date: TEST_DATE,
        room: TEST_ROOM,
        first: `${START}~${LONG_END}`,
        second: `${START}~${SHORT_END}`,
      },
      legacyCollisionKey: hashKioskKeyLegacy(TEST_PHONE, TEST_DATE, START),
      v2Keys: {
        first: longBooking.id,
        second: shortBooking.id,
        distinct: longBooking.id !== shortBooking.id,
      },
      rowCount: rows.length,
      rows: rows.map((row) => ({
        id: row.id,
        date: row.date,
        start: row.start_time,
        end: row.end_time,
        room: row.room,
        naverBlocked: row.naver_blocked === 1,
        lastBlockResult: row.last_block_result,
        lastBlockReason: row.last_block_reason,
      })),
      rolledBack: true,
    };

    await client.query('ROLLBACK');
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
    process.exitCode = summary.success ? 0 : 1;
  } catch (error: unknown) {
    try { await client.query('ROLLBACK'); } catch (_rollbackError: unknown) {}
    throw error;
  } finally {
    client.release();
    await pgPool.closeAll().catch((_closeError: unknown) => {});
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : '(no message)';
  process.stderr.write(`test-kiosk-block-key-v2 실패: ${message}\n`);
  if (error instanceof Error && error.stack) process.stderr.write(`${error.stack}\n`);
  if (!(error instanceof Error && error.stack)) {
    process.stderr.write(`${JSON.stringify(error, Object.getOwnPropertyNames((error as object) || {}), 2)}\n`);
  }
  process.exit(1);
});
