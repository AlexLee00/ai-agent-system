'use strict';

/**
 * lib/team-bus.js — 클로드팀 에이전트 통신 버스
 *
 * DB: ~/.openclaw/workspace/claude-team.db
 * 용도: 덱스터 ↔ 아처 상태 공유 + 메시지 큐 + 기술 소화 이력 + 체크 이력
 */

const path    = require('path');
const os      = require('os');
const fs      = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'claude-team.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  return _db;
}

// ─── 에이전트 상태 ──────────────────────────────────────────────────

/**
 * 에이전트 상태 갱신
 * @param {string} agent      에이전트명 (dexter | archer)
 * @param {string} status     idle | running | error
 * @param {string|null} task  현재 작업 설명
 */
function setStatus(agent, status, task = null) {
  getDb().prepare(`
    INSERT INTO agent_state (agent, status, current_task, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT (agent) DO UPDATE SET
      status       = excluded.status,
      current_task = excluded.current_task,
      updated_at   = excluded.updated_at
  `).run(agent, status, task);
}

/**
 * 에이전트 성공 완료 마킹
 */
function markDone(agent) {
  getDb().prepare(`
    UPDATE agent_state
    SET status = 'idle', current_task = NULL,
        last_success_at = datetime('now'), updated_at = datetime('now')
    WHERE agent = ?
  `).run(agent);
}

/**
 * 에이전트 오류 마킹
 * @param {string} agent
 * @param {string} errMsg
 */
function markError(agent, errMsg) {
  getDb().prepare(`
    UPDATE agent_state
    SET status = 'error', current_task = NULL,
        last_error = ?, updated_at = datetime('now')
    WHERE agent = ?
  `).run(String(errMsg).slice(0, 500), agent);
}

/**
 * 전체 에이전트 상태 조회
 * @returns {Array}
 */
function getAllStatuses() {
  return getDb().prepare(`SELECT * FROM agent_state ORDER BY agent`).all();
}

/**
 * 특정 에이전트 상태 조회
 * @param {string} agent
 * @returns {object|null}
 */
function getStatus(agent) {
  return getDb().prepare(`SELECT * FROM agent_state WHERE agent = ?`).get(agent) || null;
}

// ─── 메시지 큐 ──────────────────────────────────────────────────────

/**
 * 메시지 전송
 * @param {string} from
 * @param {string} to      수신 에이전트 (기본: 'all')
 * @param {string} type    info | warn | alert | patch
 * @param {string} subject
 * @param {string} body
 * @returns {number} 삽입된 메시지 ID
 */
function sendMessage(from, to = 'all', type = 'info', subject = '', body = '') {
  const result = getDb().prepare(`
    INSERT INTO messages (from_agent, to_agent, type, subject, body)
    VALUES (?, ?, ?, ?, ?)
  `).run(from, to, type, subject, body);
  return result.lastInsertRowid;
}

/**
 * 미확인 메시지 조회
 * @param {string|null} toAgent  null이면 전체
 * @returns {Array}
 */
function getMessages(toAgent = null) {
  if (toAgent) {
    return getDb().prepare(`
      SELECT * FROM messages
      WHERE acked = 0 AND (to_agent = ? OR to_agent = 'all')
      ORDER BY created_at ASC
    `).all(toAgent);
  }
  return getDb().prepare(`
    SELECT * FROM messages WHERE acked = 0 ORDER BY created_at ASC
  `).all();
}

/**
 * 메시지 확인 처리
 * @param {number} id
 */
function ackMessage(id) {
  getDb().prepare(`
    UPDATE messages SET acked = 1, acked_at = datetime('now') WHERE id = ?
  `).run(id);
}

/**
 * 오래된 확인 메시지 정리 (기본: 7일 이전)
 * @param {number} days
 */
function cleanupOldMessages(days = 7) {
  getDb().prepare(`
    DELETE FROM messages
    WHERE acked = 1 AND acked_at < datetime('now', ? || ' days')
  `).run(`-${days}`);
}

// ─── 기술 소화 이력 ─────────────────────────────────────────────────

/**
 * 기술 소화 항목 저장
 * @param {object} opts { runDate, source, title, version, body }
 */
function addTechDigest({ runDate, source, title, version = null, body = null }) {
  getDb().prepare(`
    INSERT INTO tech_digest (run_date, source, title, version, body)
    VALUES (?, ?, ?, ?, ?)
  `).run(runDate, source, title, version, body);
}

/**
 * 미알림 소화 항목 조회
 * @returns {Array}
 */
function getUnnotifiedDigests() {
  return getDb().prepare(`
    SELECT * FROM tech_digest WHERE notified = 0 ORDER BY created_at ASC
  `).all();
}

/**
 * 소화 항목 알림 완료 처리
 * @param {number} id
 */
function markDigestNotified(id) {
  getDb().prepare(`UPDATE tech_digest SET notified = 1 WHERE id = ?`).run(id);
}

/**
 * 최근 기술 소화 이력 조회
 * @param {number} limit
 * @returns {Array}
 */
function getRecentDigests(limit = 20) {
  return getDb().prepare(`
    SELECT * FROM tech_digest ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

// ─── 체크 이력 ──────────────────────────────────────────────────────

/**
 * 덱스터 체크 결과 기록
 * @param {object} opts { checkName, status, itemCount, errorCount, detail }
 */
function recordCheck({ checkName, status, itemCount = 0, errorCount = 0, detail = null }) {
  getDb().prepare(`
    INSERT INTO check_history (check_name, status, item_count, error_count, detail)
    VALUES (?, ?, ?, ?, ?)
  `).run(checkName, status, itemCount, errorCount, detail ? JSON.stringify(detail) : null);
}

/**
 * 최근 체크 이력 조회
 * @param {string|null} checkName  null이면 전체
 * @param {number} limit
 * @returns {Array}
 */
function getRecentChecks(checkName = null, limit = 50) {
  if (checkName) {
    return getDb().prepare(`
      SELECT * FROM check_history WHERE check_name = ?
      ORDER BY ran_at DESC LIMIT ?
    `).all(checkName, limit);
  }
  return getDb().prepare(`
    SELECT * FROM check_history ORDER BY ran_at DESC LIMIT ?
  `).all(limit);
}

// ─── 유틸 ───────────────────────────────────────────────────────────

function close() {
  if (_db) { _db.close(); _db = null; }
}

module.exports = {
  getDb,
  // 에이전트 상태
  setStatus, markDone, markError, getAllStatuses, getStatus,
  // 메시지 큐
  sendMessage, getMessages, ackMessage, cleanupOldMessages,
  // 기술 소화 이력
  addTechDigest, getUnnotifiedDigests, markDigestNotified, getRecentDigests,
  // 체크 이력
  recordCheck, getRecentChecks,
  // 유틸
  close,
};
