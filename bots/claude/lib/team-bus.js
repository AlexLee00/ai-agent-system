'use strict';

/**
 * lib/team-bus.js — 클로드팀 에이전트 통신 버스
 *
 * DB: PostgreSQL jay.claude 스키마
 * 용도: 덱스터 ↔ 아처 상태 공유 + 메시지 큐 + 기술 소화 이력 + 체크 이력
 */

const pgPool = require('../../../packages/core/lib/pg-pool');

const SCHEMA = 'claude';

// ─── 에이전트 상태 ──────────────────────────────────────────────────

/**
 * 에이전트 상태 갱신
 * @param {string} agent      에이전트명 (dexter | archer)
 * @param {string} status     idle | running | error
 * @param {string|null} task  현재 작업 설명
 */
async function setStatus(agent, status, task = null) {
  await pgPool.run(SCHEMA, `
    INSERT INTO agent_state (agent, status, current_task, updated_at)
    VALUES ($1, $2, $3, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
    ON CONFLICT (agent) DO UPDATE SET
      status       = EXCLUDED.status,
      current_task = EXCLUDED.current_task,
      updated_at   = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
  `, [agent, status, task]);
}

/**
 * 에이전트 성공 완료 마킹
 */
async function markDone(agent) {
  await pgPool.run(SCHEMA, `
    UPDATE agent_state
    SET status = 'idle', current_task = NULL,
        last_success_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
        updated_at      = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    WHERE agent = $1
  `, [agent]);
}

/**
 * 에이전트 오류 마킹
 */
async function markError(agent, errMsg) {
  await pgPool.run(SCHEMA, `
    UPDATE agent_state
    SET status = 'error', current_task = NULL,
        last_error = $1,
        updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    WHERE agent = $2
  `, [String(errMsg).slice(0, 500), agent]);
}

/**
 * 전체 에이전트 상태 조회
 */
async function getAllStatuses() {
  return pgPool.query(SCHEMA, `SELECT * FROM agent_state ORDER BY agent`);
}

/**
 * 특정 에이전트 상태 조회
 */
async function getStatus(agent) {
  return pgPool.get(SCHEMA, `SELECT * FROM agent_state WHERE agent = $1`, [agent]);
}

// ─── 메시지 큐 ──────────────────────────────────────────────────────

/**
 * 메시지 전송
 * @returns {Promise<number>} 삽입된 메시지 ID
 */
async function sendMessage(from, to = 'all', type = 'info', subject = '', body = '') {
  const rows = await pgPool.query(SCHEMA, `
    INSERT INTO messages (from_agent, to_agent, type, subject, body)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id
  `, [from, to, type, subject, body]);
  return rows[0]?.id;
}

/**
 * 미확인 메시지 조회
 */
async function getMessages(toAgent = null) {
  if (toAgent) {
    return pgPool.query(SCHEMA, `
      SELECT * FROM messages
      WHERE acked = 0 AND (to_agent = $1 OR to_agent = 'all')
      ORDER BY created_at ASC
    `, [toAgent]);
  }
  return pgPool.query(SCHEMA, `
    SELECT * FROM messages WHERE acked = 0 ORDER BY created_at ASC
  `);
}

/**
 * 메시지 확인 처리
 */
async function ackMessage(id) {
  await pgPool.run(SCHEMA, `
    UPDATE messages SET acked = 1, acked_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    WHERE id = $1
  `, [id]);
}

/**
 * 오래된 확인 메시지 정리
 */
async function cleanupOldMessages(days = 7) {
  await pgPool.run(SCHEMA, `
    DELETE FROM messages
    WHERE acked = 1 AND acked_at < to_char(now() - INTERVAL '${parseInt(days)} days', 'YYYY-MM-DD HH24:MI:SS')
  `);
}

// ─── 기술 소화 이력 ─────────────────────────────────────────────────

/**
 * 기술 소화 항목 저장
 */
async function addTechDigest({ runDate, source, title, version = null, body = null }) {
  await pgPool.run(SCHEMA, `
    INSERT INTO tech_digest (run_date, source, title, version, body)
    VALUES ($1, $2, $3, $4, $5)
  `, [runDate, source, title, version, body]);
}

/**
 * 미알림 소화 항목 조회
 */
async function getUnnotifiedDigests() {
  return pgPool.query(SCHEMA, `
    SELECT * FROM tech_digest WHERE notified = 0 ORDER BY created_at ASC
  `);
}

/**
 * 소화 항목 알림 완료 처리
 */
async function markDigestNotified(id) {
  await pgPool.run(SCHEMA, `UPDATE tech_digest SET notified = 1 WHERE id = $1`, [id]);
}

/**
 * 최근 기술 소화 이력 조회
 */
async function getRecentDigests(limit = 20) {
  return pgPool.query(SCHEMA, `
    SELECT * FROM tech_digest ORDER BY created_at DESC LIMIT $1
  `, [limit]);
}

// ─── 체크 이력 ──────────────────────────────────────────────────────

/**
 * 덱스터 체크 결과 기록
 */
async function recordCheck({ checkName, status, itemCount = 0, errorCount = 0, detail = null }) {
  await pgPool.run(SCHEMA, `
    INSERT INTO check_history (check_name, status, item_count, error_count, detail)
    VALUES ($1, $2, $3, $4, $5)
  `, [checkName, status, itemCount, errorCount, detail ? JSON.stringify(detail) : null]);
}

/**
 * 최근 체크 이력 조회
 */
async function getRecentChecks(checkName = null, limit = 50) {
  if (checkName) {
    return pgPool.query(SCHEMA, `
      SELECT * FROM check_history WHERE check_name = $1
      ORDER BY ran_at DESC LIMIT $2
    `, [checkName, limit]);
  }
  return pgPool.query(SCHEMA, `
    SELECT * FROM check_history ORDER BY ran_at DESC LIMIT $1
  `, [limit]);
}

// ─── 유틸 ───────────────────────────────────────────────────────────

async function close() {
  await pgPool.closeAll();
}

module.exports = {
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
