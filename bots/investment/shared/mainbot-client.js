/**
 * shared/mainbot-client.js — 루나팀 → 메인봇 알람 발행 클라이언트 (ESM)
 *
 * claude-team.db mainbot_queue에 INSERT.
 */

import { createRequire } from 'module';
import { join }          from 'path';
import { homedir }       from 'os';
import { existsSync, mkdirSync } from 'fs';

const require  = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const DB_PATH = join(homedir(), '.openclaw', 'workspace', 'claude-team.db');

let _db = null;
function getDb() {
  if (_db) return _db;
  try {
    const dir = DB_PATH.split('/').slice(0, -1).join('/');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    _db = Database(DB_PATH);
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
 * @param {string} opts.from_bot     발신 봇 ID (luna, jason, tyler, molly, chris...)
 * @param {string} [opts.team]       팀명 (기본: investment)
 * @param {string} opts.event_type   이벤트 유형 (trade|alert|system|report)
 * @param {number} [opts.alert_level] 1~4 (기본: 2=MEDIUM)
 * @param {string} opts.message      사람이 읽는 메시지
 * @param {object} [opts.payload]    JSON 구조화 데이터
 */
export function publishToMainBot({ from_bot, team = 'investment', event_type, alert_level = 2, message, payload }) {
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
