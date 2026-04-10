#!/usr/bin/env node
'use strict';

/**
 * migrations/002_dexter_patterns.js — 덱스터 오류 이력 테이블
 *
 * DB 위치: ~/.openclaw/workspace/claude-team.db
 * 테이블:
 *   - dexter_error_log : 체크 실행 시 발견된 오류/경고 항목 누적
 */

exports.version = 3;
exports.name    = 'dexter_patterns';

exports.up = function(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS dexter_error_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      check_name  TEXT NOT NULL,
      label       TEXT NOT NULL,
      status      TEXT NOT NULL,   -- 'error' | 'warn'
      detail      TEXT,
      detected_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_del_detected ON dexter_error_log(detected_at);
    CREATE INDEX IF NOT EXISTS idx_del_label    ON dexter_error_log(check_name, label);
  `);
};

// ─── 단독 실행 시 마이그레이션 적용 ─────────────────────────────────
if (require.main === module) {
  const os       = require('os');
  const path     = require('path');
  const Database = require('better-sqlite3');

  const DB_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'claude-team.db');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  const existing = db.prepare(`
    SELECT version FROM schema_migrations WHERE version = ?
  `).get(exports.version);

  if (existing) {
    console.log(`✅ 마이그레이션 v${exports.version} 이미 적용됨`);
  } else {
    exports.up(db);
    db.prepare(`
      INSERT INTO schema_migrations (version, name) VALUES (?, ?)
    `).run(exports.version, exports.name);
    console.log(`✅ 마이그레이션 v${exports.version} (${exports.name}) 적용 완료`);
  }

  db.close();
}
