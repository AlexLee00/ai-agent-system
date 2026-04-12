'use strict';

/**
 * 002_daily_summary_columns.js — daily_summary 컬럼 추가 기준선
 *
 * SQLite 시절에는 PRAGMA/ALTER TABLE로 컬럼을 보강했지만,
 * 현재 PostgreSQL reservation 스키마에서는 해당 컬럼들이 이미 기준 스키마에 포함된다.
 * 따라서 이 마이그레이션은 버전 호환을 위한 no-op 기준선으로 유지한다.
 */

exports.version = 2;
exports.name = 'daily_summary_columns';

exports.up = async function up() {
  // PostgreSQL 기준선에서는 no-op
};

exports.down = async function down() {
  throw new Error('daily_summary_columns down()은 PostgreSQL 운영 환경에서 지원하지 않습니다.');
};
