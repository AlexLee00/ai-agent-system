#!/usr/bin/env node
'use strict';

/**
 * migrations/003_bot_commands.js — 제이 → 팀장 명령 채널
 *
 * claude-team.db 확장:
 *   - bot_commands  제이가 각 팀장 봇에게 내리는 명령 큐
 */

const path     = require('path');
const os       = require('os');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'claude-team.db');

function run() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const already = db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(4);
  if (already) {
    console.log('✅ 003_bot_commands 이미 적용됨 — 스킵');
    db.close();
    return;
  }

  console.log('🔧 003_bot_commands 마이그레이션 시작...');

  db.exec(`
    -- 제이 → 팀장 명령 큐
    CREATE TABLE IF NOT EXISTS bot_commands (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      to_bot      TEXT NOT NULL,            -- 'ska' | 'luna' | 'dexter'
      command     TEXT NOT NULL,            -- 'query_reservations' | 'restart_andy' 등
      args        TEXT DEFAULT '{}',        -- JSON 인자
      status      TEXT DEFAULT 'pending',   -- 'pending' | 'running' | 'done' | 'error'
      result      TEXT,                     -- JSON 결과 (팀장 응답)
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      done_at     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bc_status  ON bot_commands(to_bot, status);
    CREATE INDEX IF NOT EXISTS idx_bc_created ON bot_commands(created_at);
  `);

  db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(4, '003_bot_commands');

  console.log('✅ 003_bot_commands 마이그레이션 완료');
  console.log('   추가된 테이블: bot_commands');

  try { db.pragma('wal_checkpoint(TRUNCATE)'); } catch {}
  db.close();
}

run();
