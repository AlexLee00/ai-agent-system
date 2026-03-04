'use strict';

/**
 * lib/mainbot-client.js — 클로드팀 → 메인봇 알람 발행 클라이언트 (CJS)
 *
 * claude-team.db mainbot_queue에 INSERT.
 */

const path     = require('path');
const os       = require('os');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'claude-team.db');

let _db = null;
function getDb() {
  if (_db) return _db;
  try {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
  } catch (e) {
    console.warn(`[mainbot-client] DB 연결 실패: ${e.message}`);
    return null;
  }
  return _db;
}

/**
 * 메인봇 큐에 알람 발행
 * @param {object} opts
 * @param {string} opts.from_bot     발신 봇 ID (dexter, archer)
 * @param {string} [opts.team]       팀명 (기본: claude)
 * @param {string} opts.event_type   이벤트 유형 (system|report|alert)
 * @param {number} [opts.alert_level] 1~4 (기본: 2=MEDIUM)
 * @param {string} opts.message      사람이 읽는 메시지
 * @param {object} [opts.payload]    JSON 구조화 데이터
 */
function publishToMainBot({ from_bot, team = 'claude', event_type, alert_level = 2, message, payload }) {
  const db = getDb();
  if (!db) return false;
  try {
    db.prepare(`
      INSERT INTO mainbot_queue (from_bot, team, event_type, alert_level, message, payload)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(from_bot, team, event_type, alert_level, message, payload ? JSON.stringify(payload) : null);
    return true;
  } catch (e) {
    console.warn(`[mainbot-client] 큐 삽입 실패: ${e.message}`);
    return false;
  }
}

module.exports = { publishToMainBot };
