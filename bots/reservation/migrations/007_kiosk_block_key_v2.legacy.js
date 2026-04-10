'use strict';

/**
 * 007_kiosk_block_key_v2.js — kiosk_blocks 식별키 v2 재키잉
 *
 * 목적:
 *   - 기존 phone|date|start 기반 키 충돌을 줄이기 위해
 *     phone|date|start|end|room 기반 v2 키로 row id를 재생성한다.
 *   - 취소 후 같은 시작시각 재예약(종료시각/룸 변경) 케이스를 더 안전하게 분리한다.
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const { decrypt, hashKioskKey } = require('../lib/crypto');

const SCHEMA = 'reservation';

exports.version = 7;
exports.name = 'kiosk_block_key_v2';

exports.up = async function() {
  const rows = await pgPool.query(SCHEMA, 'SELECT * FROM kiosk_blocks ORDER BY date ASC, start_time ASC');
  for (const row of rows) {
    const phoneRaw = decrypt(row.phone_raw_enc);
    const nextId = hashKioskKey(phoneRaw, row.date, row.start_time, row.end_time, row.room);
    if (row.id === nextId) continue;

    const existing = await pgPool.get(SCHEMA, 'SELECT id FROM kiosk_blocks WHERE id = $1', [nextId]);
    if (existing) {
      await pgPool.run(SCHEMA, `
        UPDATE kiosk_blocks
           SET name_enc = COALESCE(kiosk_blocks.name_enc, $2),
               amount = GREATEST(COALESCE(kiosk_blocks.amount, 0), COALESCE($3, 0)),
               naver_blocked = CASE WHEN kiosk_blocks.naver_blocked = 1 OR $4 = 1 THEN 1 ELSE 0 END,
               first_seen_at = COALESCE(kiosk_blocks.first_seen_at, $5),
               blocked_at = COALESCE(kiosk_blocks.blocked_at, $6),
               naver_unblocked_at = COALESCE(kiosk_blocks.naver_unblocked_at, $7),
               last_block_attempt_at = COALESCE($8, kiosk_blocks.last_block_attempt_at),
               last_block_result = COALESCE($9, kiosk_blocks.last_block_result),
               last_block_reason = COALESCE($10, kiosk_blocks.last_block_reason),
               block_retry_count = GREATEST(COALESCE(kiosk_blocks.block_retry_count, 0), COALESCE($11, 0))
         WHERE id = $1
      `, [
        nextId,
        row.name_enc,
        row.amount,
        row.naver_blocked,
        row.first_seen_at,
        row.blocked_at,
        row.naver_unblocked_at,
        row.last_block_attempt_at,
        row.last_block_result,
        row.last_block_reason,
        row.block_retry_count,
      ]);
      await pgPool.run(SCHEMA, 'DELETE FROM kiosk_blocks WHERE id = $1', [row.id]);
      continue;
    }

    await pgPool.run(SCHEMA, 'UPDATE kiosk_blocks SET id = $1 WHERE id = $2', [nextId, row.id]);
  }
};

exports.down = async function() {
  // 불가역 재키잉이라 down은 no-op
};
