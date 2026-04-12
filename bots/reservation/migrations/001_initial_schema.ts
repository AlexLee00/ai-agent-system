'use strict';

/**
 * 001_initial_schema.js — 초기 스키마 기준선
 *
 * PostgreSQL reservation 스키마 기준.
 * 실제 테이블 생성은 현재 lib/db / 운영 부팅 레일에서 이미 보장되므로
 * 이 마이그레이션은 "버전 기준선 기록" 역할만 한다.
 */

exports.version = 1;
exports.name = 'initial_schema';

exports.up = async function up() {
  // 기준선 기록 전용 no-op
};

exports.down = async function down() {
  throw new Error('initial_schema down()은 PostgreSQL 운영 환경에서 지원하지 않습니다.');
};
