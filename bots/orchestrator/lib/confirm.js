'use strict';

/**
 * lib/confirm.js — Lv3/Lv4 확인 요청 관리
 *
 * CRITICAL(4) 알람은 사용자 승인/거부 후 실행.
 * confirm_key: "yes_<id>" | "no_<id>"
 */

const path     = require('path');
const os       = require('os');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'claude-team.db');

let _db = null;
function getDb() {
  if (_db) return _db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  return _db;
}

const CONFIRM_TTL_MS = 10 * 60 * 1000; // 10분 후 만료

/**
 * 확인 요청 생성
 * @param {number} queueId   mainbot_queue.id
 * @param {string} message   확인 내용
 * @returns {{ confirmKey: string, rejectKey: string, expiresAt: string }}
 */
function createConfirm(queueId, message) {
  const expiresAt = new Date(Date.now() + CONFIRM_TTL_MS).toISOString();
  const confirmKey = `yes_${queueId}_${Date.now()}`;
  const rejectKey  = `no_${queueId}_${Date.now()}`;

  getDb().prepare(`
    INSERT INTO pending_confirms (queue_id, confirm_key, message, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(queueId, confirmKey, message, expiresAt);

  getDb().prepare(`
    INSERT INTO pending_confirms (queue_id, confirm_key, message, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(queueId, rejectKey, message, expiresAt);

  return { confirmKey, rejectKey, expiresAt };
}

/**
 * 확인 키로 대기 항목 조회
 */
function getByKey(key) {
  return getDb().prepare(`
    SELECT * FROM pending_confirms WHERE confirm_key = ? AND status = 'pending'
  `).get(key);
}

/**
 * 승인/거부 처리
 * @param {string} key     confirm_key
 * @param {string} action  'approved' | 'rejected'
 */
function resolve(key, action) {
  const now = new Date().toISOString();
  const { changes } = getDb().prepare(`
    UPDATE pending_confirms
    SET status = ?, resolved_at = ?
    WHERE confirm_key = ? AND status = 'pending' AND expires_at > ?
  `).run(action, now, key, now);
  return changes > 0;
}

/**
 * 만료된 확인 요청 정리
 */
function cleanExpired() {
  const now = new Date().toISOString();
  const { changes } = getDb().prepare(`
    UPDATE pending_confirms SET status = 'expired'
    WHERE status = 'pending' AND expires_at <= ?
  `).run(now);
  return changes;
}

module.exports = { createConfirm, getByKey, resolve, cleanExpired };
