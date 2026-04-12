'use strict';

/**
 * 005_pickko_order_raw.js — Pickko raw order/audit 테이블 추가 (PostgreSQL)
 *
 * 목적:
 *   - 일반석 direct 매출의 상품/시간권/결제시각 raw 저장
 *   - 스터디룸 예약 단위 rawAmount / policyAmount / 일치여부 저장
 *   - 이후 예측 feature / 감사 리포트 / 운영 검증에 재사용
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const SCHEMA = 'reservation';

exports.version = 5;
exports.name = 'pickko_order_raw';

exports.up = async function() {
  await pgPool.run(SCHEMA, `
    CREATE TABLE IF NOT EXISTS pickko_order_raw (
      entry_key        TEXT PRIMARY KEY,
      source_date      DATE NOT NULL,
      source_axis      TEXT NOT NULL,
      order_kind       TEXT NOT NULL,
      transaction_no   INTEGER,
      detail_href      TEXT,
      description      TEXT NOT NULL,
      raw_amount       INTEGER NOT NULL DEFAULT 0,
      payment_at       TIMESTAMPTZ,
      pay_type         TEXT,
      pay_device       TEXT,
      memo             TEXT,
      ticket_type      TEXT,
      product_hours    INTEGER,
      product_days     INTEGER,
      member_hint      TEXT,
      validity_start   DATE,
      validity_end     DATE,
      room_label       TEXT,
      room_type        TEXT,
      use_date         DATE,
      use_start_time   TEXT,
      use_end_time     TEXT,
      member_name      TEXT,
      policy_amount    INTEGER,
      amount_match     SMALLINT,
      amount_delta     INTEGER,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_pickko_order_raw_source
      ON pickko_order_raw(source_date, source_axis, order_kind)
  `);

  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_pickko_order_raw_room_use
      ON pickko_order_raw(use_date, room_type, use_start_time)
  `);

  await pgPool.run(SCHEMA, `
    CREATE INDEX IF NOT EXISTS idx_pickko_order_raw_payment_at
      ON pickko_order_raw(payment_at)
  `);
};

exports.down = async function() {
  await pgPool.run(SCHEMA, `DROP INDEX IF EXISTS idx_pickko_order_raw_payment_at`);
  await pgPool.run(SCHEMA, `DROP INDEX IF EXISTS idx_pickko_order_raw_room_use`);
  await pgPool.run(SCHEMA, `DROP INDEX IF EXISTS idx_pickko_order_raw_source`);
  await pgPool.run(SCHEMA, `DROP TABLE IF EXISTS pickko_order_raw`);
};
