'use strict';

/**
 * lib/mute-manager.js — 알람 무음 관리
 *
 * PostgreSQL jay.claude 스키마 mute_settings 테이블 기반.
 * target: 'all' | 팀명(investment/reservation/claude) | 봇명(luna/ska/dexter...)
 */

const pgPool = require('../../../packages/core/lib/pg-pool');

const SCHEMA = 'claude';

/**
 * 무음 설정
 */
async function setMute(target, durationMs, reason = '') {
  const until = new Date(Date.now() + durationMs).toISOString();
  await pgPool.run(SCHEMA, `DELETE FROM mute_settings WHERE target = $1`, [target]);
  await pgPool.run(SCHEMA, `
    INSERT INTO mute_settings (target, mute_until, reason) VALUES ($1, $2, $3)
  `, [target, until, reason]);
  return until;
}

/**
 * 무음 해제
 */
async function clearMute(target) {
  await pgPool.run(SCHEMA, 'DELETE FROM mute_settings WHERE target = $1', [target]);
}

/**
 * 특정 target이 현재 무음인지 확인
 */
async function isMuted(target) {
  const now = new Date().toISOString();
  const row = await pgPool.get(SCHEMA, `
    SELECT 1 FROM mute_settings
    WHERE target = $1 AND mute_until > $2
    LIMIT 1
  `, [target, now]);
  return !!row;
}

/**
 * 봇/팀 알람이 무음인지 확인 (all + 팀 + 봇 3단계)
 */
async function isAlertMuted(botName, teamName) {
  const [a, b, c] = await Promise.all([isMuted('all'), isMuted(teamName), isMuted(botName)]);
  return a || b || c;
}

// ─── 이벤트 타입 기반 무음 ───────────────────────────────────────────
const EVENT_PREFIX = 'event:';

async function setMuteByEvent(fromBot, eventType, durationMs, reason = '') {
  return setMute(`${EVENT_PREFIX}${fromBot}:${eventType}`, durationMs, reason);
}

async function isEventMuted(fromBot, eventType) {
  if (!fromBot || !eventType) return false;
  return isMuted(`${EVENT_PREFIX}${fromBot}:${eventType}`);
}

async function clearMuteByEvent(fromBot, eventType) {
  return clearMute(`${EVENT_PREFIX}${fromBot}:${eventType}`);
}

/**
 * 현재 활성 무음 목록
 */
async function listMutes() {
  const now = new Date().toISOString();
  return pgPool.query(SCHEMA, `
    SELECT target, mute_until, reason
    FROM mute_settings
    WHERE mute_until > $1
    ORDER BY mute_until ASC
  `, [now]);
}

/**
 * 만료된 무음 정리
 */
async function cleanExpired() {
  const now = new Date().toISOString();
  const { rowCount } = await pgPool.run(SCHEMA,
    'DELETE FROM mute_settings WHERE mute_until <= $1', [now]
  );
  return rowCount || 0;
}

/**
 * 무음 설정 파싱 ("/mute luna 2h")
 */
function parseDuration(duration) {
  const m = duration.match(/^(\d+)(m|h|d)$/i);
  if (!m) return null;
  const [, n, unit] = m;
  const ms = parseInt(n) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[unit.toLowerCase()] || 0);
  const label = { m: '분', h: '시간', d: '일' }[unit.toLowerCase()];
  return { ms, label: `${n}${label}` };
}

module.exports = { setMute, clearMute, isMuted, isAlertMuted, listMutes, cleanExpired, parseDuration, setMuteByEvent, isEventMuted, clearMuteByEvent };
