'use strict';

/**
 * 003_agent_state.js — 에이전트 상태 공유 버스 테이블 추가
 *
 * 추가 테이블:
 *   1) agent_state      에이전트 상태 공유 버스 (앤디/지미/수동 실행 상태)
 *   2) pickko_lock      픽코 어드민 단독접근 뮤텍스 (동시 접근 방지)
 *   3) pending_blocks   앤디→지미 블록 요청 큐
 */

exports.version = 3;
exports.name    = 'agent_state';

exports.up = function(db) {
  const rawDb = db.getDb();

  // 1) 에이전트 상태 공유 버스
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS agent_state (
      agent           TEXT PRIMARY KEY,
      status          TEXT NOT NULL DEFAULT 'idle',
      current_task    TEXT,
      last_success_at TEXT,
      last_error      TEXT,
      updated_at      TEXT NOT NULL
    )
  `);

  // 2) 픽코 어드민 단독접근 뮤텍스 (행 1개 고정)
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS pickko_lock (
      id          INTEGER PRIMARY KEY CHECK(id = 1),
      locked_by   TEXT,
      locked_at   TEXT,
      expires_at  TEXT
    )
  `);
  rawDb.prepare('INSERT OR IGNORE INTO pickko_lock (id) VALUES (1)').run();

  // 3) 앤디→지미 블록 요청 큐
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS pending_blocks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_enc    TEXT NOT NULL,
      date         TEXT NOT NULL,
      reason       TEXT,
      requested_by TEXT DEFAULT 'andy',
      status       TEXT DEFAULT 'pending',
      created_at   TEXT NOT NULL,
      processed_at TEXT
    )
  `);
};

exports.down = function(db) {
  const rawDb = db.getDb();
  rawDb.exec(`
    DROP TABLE IF EXISTS pending_blocks;
    DROP TABLE IF EXISTS pickko_lock;
    DROP TABLE IF EXISTS agent_state;
  `);
};
