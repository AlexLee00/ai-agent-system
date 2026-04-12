// @ts-nocheck
'use strict';

/**
 * 006_kiosk_block_attempts.js — kiosk_blocks 후속 차단 시도 원장화
 *
 * 목적:
 *   - 수동등록/키오스크 예약의 네이버 차단 시도 결과를 원장에 남긴다.
 *   - 실제 실패, 지연 후 재시도, 성공을 구분할 수 있게 한다.
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const SCHEMA = 'reservation';

exports.version = 6;
exports.name = 'kiosk_block_attempts';

exports.up = async function() {
  await pgPool.run(SCHEMA, `
    ALTER TABLE kiosk_blocks
      ADD COLUMN IF NOT EXISTS last_block_attempt_at TIMESTAMPTZ
  `);

  await pgPool.run(SCHEMA, `
    ALTER TABLE kiosk_blocks
      ADD COLUMN IF NOT EXISTS last_block_result TEXT
  `);

  await pgPool.run(SCHEMA, `
    ALTER TABLE kiosk_blocks
      ADD COLUMN IF NOT EXISTS last_block_reason TEXT
  `);

  await pgPool.run(SCHEMA, `
    ALTER TABLE kiosk_blocks
      ADD COLUMN IF NOT EXISTS block_retry_count INTEGER NOT NULL DEFAULT 0
  `);

  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_kiosk_blocks_attempt_result
      ON kiosk_blocks(last_block_result, date)
  `);
};

exports.down = async function() {
  await pgPool.run(SCHEMA, `DROP INDEX IF EXISTS idx_kiosk_blocks_attempt_result`);
  await pgPool.run(SCHEMA, `ALTER TABLE kiosk_blocks DROP COLUMN IF EXISTS block_retry_count`);
  await pgPool.run(SCHEMA, `ALTER TABLE kiosk_blocks DROP COLUMN IF EXISTS last_block_reason`);
  await pgPool.run(SCHEMA, `ALTER TABLE kiosk_blocks DROP COLUMN IF EXISTS last_block_result`);
  await pgPool.run(SCHEMA, `ALTER TABLE kiosk_blocks DROP COLUMN IF EXISTS last_block_attempt_at`);
};
