'use strict';

/**
 * 002_daily_summary_columns.js — daily_summary 컬럼 추가
 *
 * 추가 컬럼:
 *   - pickko_total       INTEGER DEFAULT 0  (픽코 전체 매출)
 *   - pickko_study_room  INTEGER DEFAULT 0  (픽코 스터디룸 매출)
 *   - general_revenue    INTEGER DEFAULT 0  (일반 이용 매출)
 *
 * 기존 DB에서도 안전하게 실행 가능:
 *   PRAGMA table_info()로 컬럼 존재 여부 확인 후 조건부 ALTER
 */

exports.version = 2;
exports.name    = 'daily_summary_columns';

exports.up = function(db) {
  const rawDb = db.getDb();
  const existing = rawDb.prepare('PRAGMA table_info(daily_summary)').all().map(r => r.name);

  const additions = [
    { col: 'pickko_total',      sql: 'ALTER TABLE daily_summary ADD COLUMN pickko_total INTEGER DEFAULT 0' },
    { col: 'pickko_study_room', sql: 'ALTER TABLE daily_summary ADD COLUMN pickko_study_room INTEGER DEFAULT 0' },
    { col: 'general_revenue',   sql: 'ALTER TABLE daily_summary ADD COLUMN general_revenue INTEGER DEFAULT 0' },
  ];

  for (const { col, sql } of additions) {
    if (!existing.includes(col)) {
      rawDb.exec(sql);
    }
  }
};

exports.down = function(db) {
  // SQLite는 DROP COLUMN을 지원하지 않음 (3.35.0 이상에서만 가능)
  // 안전을 위해 테이블 재생성 방식 사용
  const rawDb = db.getDb();
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS daily_summary_backup AS
      SELECT date, total_amount, room_amounts_json, entries_count, reported_at,
             last_reported_at, confirmed, confirmed_at
      FROM daily_summary;
    DROP TABLE daily_summary;
    ALTER TABLE daily_summary_backup RENAME TO daily_summary;
  `);
};
