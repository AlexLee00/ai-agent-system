'use strict';

/**
 * lib/confirm.js — Lv3/Lv4 확인 요청 관리
 *
 * CRITICAL(4) 알람은 사용자 승인/거부 후 실행.
 * confirm_key: "yes_<id>" | "no_<id>"
 */

const pgPool = require('../../../packages/core/lib/pg-pool');

const SCHEMA = 'claude';
const CONFIRM_TTL_MS = 10 * 60 * 1000; // 10분 후 만료

/**
 * 확인 요청 생성
 */
async function createConfirm(queueId, message) {
  const expiresAt  = new Date(Date.now() + CONFIRM_TTL_MS).toISOString();
  const confirmKey = `yes_${queueId}_${Date.now()}`;
  const rejectKey  = `no_${queueId}_${Date.now()}`;

  await pgPool.run(SCHEMA, `
    INSERT INTO pending_confirms (queue_id, confirm_key, message, expires_at)
    VALUES ($1, $2, $3, $4)
  `, [queueId, confirmKey, message, expiresAt]);

  await pgPool.run(SCHEMA, `
    INSERT INTO pending_confirms (queue_id, confirm_key, message, expires_at)
    VALUES ($1, $2, $3, $4)
  `, [queueId, rejectKey, message, expiresAt]);

  return { confirmKey, rejectKey, expiresAt };
}

/**
 * 확인 키로 대기 항목 조회
 */
async function getByKey(key) {
  return pgPool.get(SCHEMA, `
    SELECT * FROM pending_confirms WHERE confirm_key = $1 AND status = 'pending'
  `, [key]);
}

/**
 * 승인/거부 처리
 */
async function resolve(key, action) {
  const now = new Date().toISOString();
  const { rowCount } = await pgPool.run(SCHEMA, `
    UPDATE pending_confirms
    SET status = $1, resolved_at = $2
    WHERE confirm_key = $3 AND status = 'pending' AND expires_at > $2
  `, [action, now, key]);
  return (rowCount || 0) > 0;
}

/**
 * 만료된 확인 요청 정리
 */
async function cleanExpired() {
  const now = new Date().toISOString();
  const { rowCount } = await pgPool.run(SCHEMA, `
    UPDATE pending_confirms SET status = 'expired'
    WHERE status = 'pending' AND expires_at <= $1
  `, [now]);
  return rowCount || 0;
}

module.exports = { createConfirm, getByKey, resolve, cleanExpired };
