'use strict';

/**
 * lib/mute-manager.js — 알람 무음 관리
 *
 * mute_settings 테이블 기반.
 * target: 'all' | 팀명(investment/reservation/claude) | 봇명(luna/ska/dexter...)
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

/**
 * 무음 설정
 * @param {string} target     'all' | 팀명 | 봇명
 * @param {number} durationMs 무음 지속 시간 (ms)
 * @param {string} [reason]   사유
 */
function setMute(target, durationMs, reason = '') {
  const until = new Date(Date.now() + durationMs).toISOString();
  // 기존 같은 target 덮어쓰기
  getDb().prepare(`
    DELETE FROM mute_settings WHERE target = ?
  `).run(target);
  getDb().prepare(`
    INSERT INTO mute_settings (target, mute_until, reason) VALUES (?, ?, ?)
  `).run(target, until, reason);
  return until;
}

/**
 * 무음 해제
 */
function clearMute(target) {
  getDb().prepare('DELETE FROM mute_settings WHERE target = ?').run(target);
}

/**
 * 특정 target이 현재 무음인지 확인
 * @param {string} target
 * @returns {boolean}
 */
function isMuted(target) {
  const now = new Date().toISOString();
  const row = getDb().prepare(`
    SELECT 1 FROM mute_settings
    WHERE target = ? AND mute_until > ?
    LIMIT 1
  `).get(target, now);
  return !!row;
}

/**
 * 봇/팀 알람이 무음인지 확인 (all + 팀 + 봇 3단계)
 * @param {string} botName   봇 이름 (luna, dexter...)
 * @param {string} teamName  팀 이름 (investment, reservation, claude)
 * @returns {boolean}
 */
function isAlertMuted(botName, teamName) {
  return isMuted('all') || isMuted(teamName) || isMuted(botName);
}

/**
 * 현재 활성 무음 목록
 */
function listMutes() {
  const now = new Date().toISOString();
  return getDb().prepare(`
    SELECT target, mute_until, reason
    FROM mute_settings
    WHERE mute_until > ?
    ORDER BY mute_until ASC
  `).all(now);
}

/**
 * 만료된 무음 정리
 */
function cleanExpired() {
  const now = new Date().toISOString();
  const { changes } = getDb().prepare('DELETE FROM mute_settings WHERE mute_until <= ?').run(now);
  return changes;
}

/**
 * 무음 설정 파싱 ("/mute luna 2h" 또는 "/mute all 30m")
 * @param {string} target   봇명 또는 'all'
 * @param {string} duration "30m" | "1h" | "2h" | "1d"
 * @returns {{ ms: number, label: string } | null}
 */
function parseDuration(duration) {
  const m = duration.match(/^(\d+)(m|h|d)$/i);
  if (!m) return null;
  const [, n, unit] = m;
  const ms = parseInt(n) * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[unit.toLowerCase()] || 0);
  const label = { m: '분', h: '시간', d: '일' }[unit.toLowerCase()];
  return { ms, label: `${n}${label}` };
}

module.exports = { setMute, clearMute, isMuted, isAlertMuted, listMutes, cleanExpired, parseDuration };
