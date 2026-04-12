// @ts-nocheck
'use strict';

/**
 * 009_daily_summary_remove_pickko_total.js
 *
 * 목적:
 *   - daily_summary 에서 pickko_total 컬럼 제거
 *
 * 운영 규칙:
 *   - 스터디카페 매출은 payment_day|general
 *   - 스터디룸 매출은 use_day|study_room
 *   - 총합이 필요하면 general_revenue + pickko_study_room 으로 계산
 */

const pgPool = require('../../../packages/core/lib/pg-pool');
const SCHEMA = 'reservation';

exports.version = 9;
exports.name = 'daily_summary_remove_pickko_total';

exports.up = async function() {
  await pgPool.run(SCHEMA, `
    ALTER TABLE daily_summary
    DROP COLUMN IF EXISTS pickko_total
  `);
};

exports.down = async function() {
  await pgPool.run(SCHEMA, `
    ALTER TABLE daily_summary
    ADD COLUMN IF NOT EXISTS pickko_total INTEGER DEFAULT 0
  `);
};
