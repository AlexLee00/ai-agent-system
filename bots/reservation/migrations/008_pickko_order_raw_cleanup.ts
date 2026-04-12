// @ts-nocheck
'use strict';

/**
 * 008_pickko_order_raw_cleanup.js
 *
 * 목적:
 *   - pickko_order_raw 에서 payment_day/study_room row 제거
 *   - amount_delta 컬럼 제거
 *
 * 운영 규칙:
 *   - 일반매출은 payment_day/general 만 사용
 *   - 스터디룸 매출은 use_day/study_room 만 사용
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const SCHEMA = 'reservation';

exports.version = 8;
exports.name = 'pickko_order_raw_cleanup';

exports.up = async function() {
  await pgPool.run(SCHEMA, `
    DELETE FROM pickko_order_raw
    WHERE source_axis = 'payment_day'
      AND order_kind = 'study_room'
  `);

  await pgPool.run(SCHEMA, `
    ALTER TABLE pickko_order_raw
    DROP COLUMN IF EXISTS amount_delta
  `);
};

exports.down = async function() {
  await pgPool.run(SCHEMA, `
    ALTER TABLE pickko_order_raw
    ADD COLUMN IF NOT EXISTS amount_delta INTEGER
  `);
};
