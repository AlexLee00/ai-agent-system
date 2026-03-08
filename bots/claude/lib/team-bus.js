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
 * @param {string} agent      에이전트명 (dexter | archer | claude-lead)
 * @param {string} status     idle | running | error
 * @param {string|null} task  현재 작업 설명
 */
async function setStatus(agent, status, task = null) {
  try {
    await pgPool.run(SCHEMA, `
      INSERT INTO agent_state (agent, status, current_task, updated_at)
      VALUES ($1, $2, $3, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
      ON CONFLICT (agent) DO UPDATE SET
        status       = EXCLUDED.status,
        current_task = EXCLUDED.current_task,
        updated_at   = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
    `, [agent, status, task]);
  } catch (e) {
    console.warn('[team-bus] setStatus 실패 (무시):', e.message);
  }
}

/**
 * 에이전트 성공 완료 마킹
 */
async function markDone(agent) {
  try {
    await pgPool.run(SCHEMA, `
      UPDATE agent_state
      SET status = 'idle', current_task = NULL,
          last_success_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS'),
          updated_at      = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      WHERE agent = $1
    `, [agent]);
  } catch (e) {
    console.warn('[team-bus] markDone 실패 (무시):', e.message);
  }
}

/**
 * 에이전트 오류 마킹
 */
async function markError(agent, errMsg) {
  try {
    await pgPool.run(SCHEMA, `
      UPDATE agent_state
      SET status = 'error', current_task = NULL,
          last_error = $1,
          updated_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      WHERE agent = $2
    `, [String(errMsg).slice(0, 500), agent]);
  } catch (e) {
    console.warn('[team-bus] markError 실패 (무시):', e.message);
  }
}

/**
 * 전체 에이전트 상태 조회
 */
async function getAllStatuses() {
  try {
    return await pgPool.query(SCHEMA, `SELECT * FROM agent_state ORDER BY agent`);
  } catch (e) {
    console.warn('[team-bus] getAllStatuses 실패 (무시):', e.message);
    return [];
  }
}

/**
 * 특정 에이전트 상태 조회
 */
async function getStatus(agent) {
  try {
    return await pgPool.get(SCHEMA, `SELECT * FROM agent_state WHERE agent = $1`, [agent]);
  } catch (e) {
    console.warn('[team-bus] getStatus 실패 (무시):', e.message);
    return null;
  }
}

// ─── 메시지 큐 ──────────────────────────────────────────────────────

/**
 * 메시지 전송
 * @returns {Promise<number|null>} 삽입된 메시지 ID (실패 시 null)
 */
async function sendMessage(from, to = 'all', type = 'info', subject = '', body = '') {
  try {
    const rows = await pgPool.query(SCHEMA, `
      INSERT INTO messages (from_agent, to_agent, type, subject, body)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
    `, [from, to, type, subject, body]);
    return rows[0]?.id ?? null;
  } catch (e) {
    console.warn('[team-bus] sendMessage 실패 (무시):', e.message);
    return null;
  }
}

/**
 * 미확인 메시지 조회
 */
async function getMessages(toAgent = null) {
  try {
    if (toAgent) {
      return await pgPool.query(SCHEMA, `
        SELECT * FROM messages
        WHERE acked = 0 AND (to_agent = $1 OR to_agent = 'all')
        ORDER BY created_at ASC
      `, [toAgent]);
    }
    return await pgPool.query(SCHEMA, `
      SELECT * FROM messages WHERE acked = 0 ORDER BY created_at ASC
    `);
  } catch (e) {
    console.warn('[team-bus] getMessages 실패 (무시):', e.message);
    return [];
  }
}

/**
 * 메시지 확인 처리
 */
async function ackMessage(id) {
  try {
    await pgPool.run(SCHEMA, `
      UPDATE messages SET acked = 1, acked_at = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = $1
    `, [id]);
  } catch (e) {
    console.warn('[team-bus] ackMessage 실패 (무시):', e.message);
  }
}

/**
 * 오래된 확인 메시지 정리
 */
async function cleanupOldMessages(days = 7) {
  try {
    await pgPool.run(SCHEMA, `
      DELETE FROM messages
      WHERE acked = 1 AND acked_at < to_char(now() - INTERVAL '${parseInt(days)} days', 'YYYY-MM-DD HH24:MI:SS')
    `);
  } catch (e) {
    console.warn('[team-bus] cleanupOldMessages 실패 (무시):', e.message);
  }
}

// ─── 기술 소화 이력 ─────────────────────────────────────────────────

/**
 * 기술 소화 항목 저장
 */
async function addTechDigest({ runDate, source, title, version = null, body = null }) {
  try {
    await pgPool.run(SCHEMA, `
      INSERT INTO tech_digest (run_date, source, title, version, body)
      VALUES ($1, $2, $3, $4, $5)
    `, [runDate, source, title, version, body]);
  } catch (e) {
    console.warn('[team-bus] addTechDigest 실패 (무시):', e.message);
  }
}

/**
 * 미알림 소화 항목 조회
 */
async function getUnnotifiedDigests() {
  try {
    return await pgPool.query(SCHEMA, `
      SELECT * FROM tech_digest WHERE notified = 0 ORDER BY created_at ASC
    `);
  } catch (e) {
    console.warn('[team-bus] getUnnotifiedDigests 실패 (무시):', e.message);
    return [];
  }
}

/**
 * 소화 항목 알림 완료 처리
 */
async function markDigestNotified(id) {
  try {
    await pgPool.run(SCHEMA, `UPDATE tech_digest SET notified = 1 WHERE id = $1`, [id]);
  } catch (e) {
    console.warn('[team-bus] markDigestNotified 실패 (무시):', e.message);
  }
}

/**
 * 최근 기술 소화 이력 조회
 */
async function getRecentDigests(limit = 20) {
  try {
    return await pgPool.query(SCHEMA, `
      SELECT * FROM tech_digest ORDER BY created_at DESC LIMIT $1
    `, [limit]);
  } catch (e) {
    console.warn('[team-bus] getRecentDigests 실패 (무시):', e.message);
    return [];
  }
}

// ─── 체크 이력 ──────────────────────────────────────────────────────

/**
 * 덱스터 체크 결과 기록
 */
async function recordCheck({ checkName, status, itemCount = 0, errorCount = 0, detail = null }) {
  try {
    await pgPool.run(SCHEMA, `
      INSERT INTO check_history (check_name, status, item_count, error_count, detail)
      VALUES ($1, $2, $3, $4, $5)
    `, [checkName, status, itemCount, errorCount, detail ? JSON.stringify(detail) : null]);
  } catch (e) {
    console.warn('[team-bus] recordCheck 실패 (무시):', e.message);
  }
}

/**
 * 최근 체크 이력 조회
 */
async function getRecentChecks(checkName = null, limit = 50) {
  try {
    if (checkName) {
      return await pgPool.query(SCHEMA, `
        SELECT * FROM check_history WHERE check_name = $1
        ORDER BY ran_at DESC LIMIT $2
      `, [checkName, limit]);
    }
    return await pgPool.query(SCHEMA, `
      SELECT * FROM check_history ORDER BY ran_at DESC LIMIT $1
    `, [limit]);
  } catch (e) {
    console.warn('[team-bus] getRecentChecks 실패 (무시):', e.message);
    return [];
  }
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
