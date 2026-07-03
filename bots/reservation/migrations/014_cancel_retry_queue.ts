'use strict';

/**
 * 014_cancel_retry_queue.ts
 *
 * 네이버 취소 감지 후 픽코 취소 실패를 분류하고 안전하게 재시도하기 위한 큐.
 * 실제 적용은 마스터 승인 후 migration runner 또는 psql로 수행한다.
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const SCHEMA = 'reservation';

exports.version = 14;
exports.name = 'cancel_retry_queue';

exports.up = async function () {
  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS cancel_retry_queue (
      id              BIGSERIAL PRIMARY KEY,
      cancel_key      TEXT NOT NULL UNIQUE,
      booking_id      TEXT,
      phone_raw       TEXT,
      date            TEXT,
      start_time      TEXT,
      end_time        TEXT,
      room            TEXT,
      reason          TEXT NOT NULL CHECK (reason IN ('matched_fail','member_missing','network','timeout','unknown')),
      attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_retry_at   TIMESTAMPTZ,
      status          TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','succeeded','manual_required','exhausted')),
      last_exit_code  INTEGER,
      last_error      TEXT,
      metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_cancel_retry_queue_due
      ON cancel_retry_queue (status, next_retry_at)
      WHERE status = 'pending'
  `);

  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_cancel_retry_queue_booking
      ON cancel_retry_queue (booking_id)
      WHERE booking_id IS NOT NULL
  `);

  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_cancel_retry_queue_updated
      ON cancel_retry_queue (updated_at DESC)
  `);
};

exports.down = async function () {
  await pgPool.run(SCHEMA, `DROP TABLE IF EXISTS cancel_retry_queue`);
};
