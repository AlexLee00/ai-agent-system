// @ts-nocheck
'use strict';

/**
 * migrations/003_agent_heartbeats.js — claude.agent_heartbeats
 *
 * 참고용 마이그레이션 파일.
 * 실제 런타임은 PostgreSQL claude 스키마를 사용하며,
 * helper가 CREATE TABLE IF NOT EXISTS로 자기 복구한다.
 */

exports.version = 4;
exports.name = 'agent_heartbeats';

exports.up = function (db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_heartbeats (
      agent_name TEXT PRIMARY KEY,
      last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'ok',
      meta TEXT NOT NULL DEFAULT '{}'
    );
  `);

  try {
    db.prepare(
      `INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)`
    ).run(exports.version, exports.name);
  } catch (_) {
    // sqlite team-bus가 없는 환경은 무시
  }
};

exports.down = function (db) {
  db.exec(`DROP TABLE IF EXISTS agent_heartbeats;`);
  try {
    db.prepare(`DELETE FROM schema_migrations WHERE version = ?`).run(exports.version);
  } catch (_) {
    // 무시
  }
};
