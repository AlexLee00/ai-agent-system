'use strict';

/**
 * 004_agent_events_tasks.js — 3계층 에이전트 이벤트/작업 버스 테이블 추가
 *
 * 추가 테이블:
 *   1) agent_events   팀원 → 팀장 이벤트 보고 큐
 *   2) agent_tasks    팀장 → 팀원 작업 지시 큐
 */

exports.version = 4;
exports.name    = 'agent_events_tasks';

exports.up = function(db) {
  const rawDb = db.getDb();

  // 1) 팀원 → 팀장 이벤트 보고 큐
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS agent_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent   TEXT NOT NULL,
      to_agent     TEXT NOT NULL,
      event_type   TEXT NOT NULL,
      priority     TEXT NOT NULL DEFAULT 'normal',
      payload      TEXT,
      processed    INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL,
      processed_at TEXT
    )
  `);
  rawDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_events_unprocessed
      ON agent_events(to_agent, processed, created_at)
  `);

  // 2) 팀장 → 팀원 작업 지시 큐
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      from_agent   TEXT NOT NULL,
      to_agent     TEXT NOT NULL,
      task_type    TEXT NOT NULL,
      priority     TEXT NOT NULL DEFAULT 'normal',
      payload      TEXT,
      status       TEXT NOT NULL DEFAULT 'pending',
      result       TEXT,
      created_at   TEXT NOT NULL,
      completed_at TEXT
    )
  `);
  rawDb.exec(`
    CREATE INDEX IF NOT EXISTS idx_tasks_pending
      ON agent_tasks(to_agent, status, created_at)
  `);
};

exports.down = function(db) {
  const rawDb = db.getDb();
  rawDb.exec(`
    DROP INDEX IF EXISTS idx_tasks_pending;
    DROP INDEX IF EXISTS idx_events_unprocessed;
    DROP TABLE IF EXISTS agent_tasks;
    DROP TABLE IF EXISTS agent_events;
  `);
};
