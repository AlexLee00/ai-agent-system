// @ts-nocheck
'use strict';

/**
 * migrations/001_team_bus.js — 클로드팀 통신 버스 스키마
 *
 * DB 위치: ~/.openclaw/workspace/claude-team.db
 * 테이블:
 *   - agent_state   : 에이전트 상태 공유 버스
 *   - messages      : 에이전트 간 메시지 큐
 *   - tech_digest   : 아처 기술 트렌드 소화 이력
 *   - check_history : 덱스터 체크 실행 이력
 */

exports.version = 1;
exports.name    = 'team_bus';

exports.up = function(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_state (
      agent           TEXT PRIMARY KEY,
      status          TEXT NOT NULL DEFAULT 'idle',
      current_task    TEXT,
      last_success_at TEXT,
      last_error      TEXT,
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent   TEXT NOT NULL,
      to_agent     TEXT NOT NULL DEFAULT 'all',
      type         TEXT NOT NULL DEFAULT 'info',
      subject      TEXT,
      body         TEXT,
      acked        INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      acked_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS tech_digest (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      run_date    TEXT NOT NULL,
      source      TEXT NOT NULL,
      title       TEXT NOT NULL,
      version     TEXT,
      body        TEXT,
      notified    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS check_history (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      check_name   TEXT NOT NULL,
      status       TEXT NOT NULL,
      item_count   INTEGER DEFAULT 0,
      error_count  INTEGER DEFAULT 0,
      detail       TEXT,
      ran_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    INSERT OR IGNORE INTO agent_state (agent, status, updated_at)
      VALUES ('dexter', 'idle', datetime('now')),
             ('archer', 'idle', datetime('now'));
  `);

  db.prepare(
    `INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)`
  ).run(exports.version, exports.name);
};

exports.down = function(db) {
  db.exec(`
    DROP TABLE IF EXISTS check_history;
    DROP TABLE IF EXISTS tech_digest;
    DROP TABLE IF EXISTS messages;
    DROP TABLE IF EXISTS agent_state;
    DELETE FROM schema_migrations WHERE version = 1;
  `);
};
