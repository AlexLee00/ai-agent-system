'use strict';

/**
 * lib/state-bus.js — 에이전트 간 상태 공유 버스
 *
 * state.db의 agent_state / pickko_lock / pending_blocks 테이블을 이용하여
 * 앤디(naver-monitor), 지미(kiosk-monitor), 수동 실행 스크립트 간 통신 제공.
 *
 * 의존: lib/db.js (getDb 함수)
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(process.env.HOME, '.openclaw', 'workspace', 'state.db');

let _db = null;

function _getDb() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  return _db;
}

// ─── 에이전트 상태 ──────────────────────────────────────────────────

/**
 * 에이전트 상태 갱신
 * @param {string} agent       - 'andy' | 'jimmy' | 'manual'
 * @param {string} status      - 'idle' | 'running' | 'error'
 * @param {string|null} currentTask
 * @param {string|null} errorMsg   - status='error' 시 오류 메시지
 */
function updateAgentState(agent, status, currentTask = null, errorMsg = null) {
  const db = _getDb();
  const now = new Date().toISOString();
  const lastSuccess = (status === 'idle') ? now : undefined;

  if (lastSuccess !== undefined) {
    db.prepare(`
      INSERT INTO agent_state (agent, status, current_task, last_success_at, last_error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(agent) DO UPDATE SET
        status          = excluded.status,
        current_task    = excluded.current_task,
        last_success_at = excluded.last_success_at,
        last_error      = excluded.last_error,
        updated_at      = excluded.updated_at
    `).run(agent, status, currentTask, errorMsg, now, now);
  } else {
    db.prepare(`
      INSERT INTO agent_state (agent, status, current_task, last_success_at, last_error, updated_at)
      VALUES (?, ?, ?, NULL, ?, ?)
      ON CONFLICT(agent) DO UPDATE SET
        status       = excluded.status,
        current_task = excluded.current_task,
        last_error   = excluded.last_error,
        updated_at   = excluded.updated_at
    `).run(agent, status, currentTask, errorMsg, now);
  }
}

/**
 * 특정 에이전트 상태 조회
 * @returns {{ agent, status, current_task, last_success_at, last_error, updated_at } | null}
 */
function getAgentState(agent) {
  const db = _getDb();
  return db.prepare('SELECT * FROM agent_state WHERE agent = ?').get(agent) || null;
}

/**
 * 전체 에이전트 상태 배열 조회
 * @returns {Array}
 */
function getAllAgentStates() {
  const db = _getDb();
  return db.prepare('SELECT * FROM agent_state ORDER BY agent').all();
}

// ─── 픽코 락 ────────────────────────────────────────────────────────

/**
 * 픽코 어드민 락 획득 시도
 * @param {string} agentName
 * @param {number} ttlMs  - 락 유효시간 (기본 5분)
 * @returns {boolean}     - true: 획득 성공, false: 이미 락됨
 */
function acquirePickkoLock(agentName, ttlMs = 5 * 60 * 1000) {
  const db = _getDb();
  cleanupExpiredLock();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  const nowStr = now.toISOString();

  // locked_by가 null인 경우에만 획득 (원자적 UPDATE)
  const result = db.prepare(`
    UPDATE pickko_lock
    SET locked_by = ?, locked_at = ?, expires_at = ?
    WHERE id = 1 AND locked_by IS NULL
  `).run(agentName, nowStr, expiresAt);

  return result.changes === 1;
}

/**
 * 픽코 어드민 락 해제
 * @param {string} agentName - 본인이 획득한 락만 해제 가능
 * @returns {boolean}
 */
function releasePickkoLock(agentName) {
  const db = _getDb();
  const result = db.prepare(`
    UPDATE pickko_lock
    SET locked_by = NULL, locked_at = NULL, expires_at = NULL
    WHERE id = 1 AND locked_by = ?
  `).run(agentName);
  return result.changes === 1;
}

/**
 * 픽코 락 상태 조회
 * @returns {{ locked: boolean, by: string|null, expiresAt: Date|null }}
 */
function isPickkoLocked() {
  const db = _getDb();
  const row = db.prepare('SELECT * FROM pickko_lock WHERE id = 1').get();
  if (!row || !row.locked_by) return { locked: false, by: null, expiresAt: null };
  return {
    locked: true,
    by: row.locked_by,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
  };
}

/**
 * TTL 초과 만료 락 자동 해제
 */
function cleanupExpiredLock() {
  const db = _getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE pickko_lock
    SET locked_by = NULL, locked_at = NULL, expires_at = NULL
    WHERE id = 1 AND expires_at IS NOT NULL AND expires_at < ?
  `).run(now);
}

// ─── 블록 요청 큐 (앤디→지미) ──────────────────────────────────────

/**
 * 블록 요청 추가
 * @param {string} phoneEnc    - 암호화된 전화번호
 * @param {string} date        - 'YYYY-MM-DD'
 * @param {string|null} reason - 차단 사유
 * @param {string} requestedBy - 요청 에이전트 (기본 'andy')
 * @returns {number} 생성된 행 ID
 */
function enqueuePendingBlock(phoneEnc, date, reason = null, requestedBy = 'andy') {
  const db = _getDb();
  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO pending_blocks (phone_enc, date, reason, requested_by, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(phoneEnc, date, reason, requestedBy, now);
  return result.lastInsertRowid;
}

/**
 * 처리 대기 블록 목록 조회
 * @returns {Array}
 */
function dequeuePendingBlocks() {
  const db = _getDb();
  return db.prepare(
    "SELECT * FROM pending_blocks WHERE status = 'pending' ORDER BY created_at"
  ).all();
}

/**
 * 블록 처리 완료 표시
 * @param {number} id
 * @param {string} status - 'done' | 'failed' | 'skipped'
 */
function markBlockProcessed(id, status = 'done') {
  const db = _getDb();
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE pending_blocks SET status = ?, processed_at = ? WHERE id = ?
  `).run(status, now, id);
}

module.exports = {
  updateAgentState,
  getAgentState,
  getAllAgentStates,
  acquirePickkoLock,
  releasePickkoLock,
  isPickkoLocked,
  cleanupExpiredLock,
  enqueuePendingBlock,
  dequeuePendingBlocks,
  markBlockProcessed,
};
