'use strict';

/**
 * 001_initial_schema.js — 초기 스키마 기준선
 *
 * 테이블: reservations, cancelled_keys, kiosk_blocks, alerts,
 *         daily_summary, room_revenue
 *
 * 실제 테이블 생성은 lib/db.js의 _initSchema()가 담당 (CREATE TABLE IF NOT EXISTS).
 * 이 마이그레이션은 버전 기준선을 기록하는 역할만 한다.
 */

exports.version = 1;
exports.name    = 'initial_schema';

exports.up = function(db) {
  // _initSchema()가 이미 모든 테이블을 생성하므로 여기서는 no-op
  // 기존 DB에서도 안전하게 실행 가능
};

exports.down = function(db) {
  // 기준선 롤백 = 전체 삭제 (위험 — 프로덕션에서 사용 금지)
  const tables = ['room_revenue', 'daily_summary', 'alerts', 'kiosk_blocks', 'cancelled_keys', 'reservations'];
  for (const t of tables) {
    db.getDb().exec(`DROP TABLE IF EXISTS ${t}`);
  }
};
