'use strict';

/**
 * lib/error-history.js — 덱스터 오류 이력 관리
 *
 * 기능:
 *   - saveErrorItems(results): 체크 결과에서 error/warn 항목을 DB에 저장
 *   - getPatterns(days, minCount): 반복 오류 패턴 조회
 *   - getNewErrors(sinceHours): 최근 첫 등장 오류 조회
 *   - cleanup(keepDays): 오래된 이력 삭제
 */

const os       = require('os');
const path     = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(os.homedir(), '.openclaw', 'workspace', 'claude-team.db');

let _db = null;
function getDb() {
  if (_db) return _db;
  try {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    // 테이블 없으면 자동 생성 (마이그레이션 미실행 환경 대비)
    _db.exec(`
      CREATE TABLE IF NOT EXISTS dexter_error_log (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        check_name  TEXT NOT NULL,
        label       TEXT NOT NULL,
        status      TEXT NOT NULL,
        detail      TEXT,
        detected_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_del_detected ON dexter_error_log(detected_at);
      CREATE INDEX IF NOT EXISTS idx_del_label    ON dexter_error_log(check_name, label);
    `);
  } catch { return null; }
  return _db;
}

// 패턴 분석에서 제외할 레이블 (개발 중 자연스러운 상태 — false positive 방지)
const PATTERN_SKIP_LABELS = ['git 상태'];

/**
 * 체크 결과에서 error/warn 항목을 모두 저장
 * @param {Array} results  dexter check results []
 */
function saveErrorItems(results) {
  const db = getDb();
  if (!db) return;

  const insert = db.prepare(`
    INSERT INTO dexter_error_log (check_name, label, status, detail)
    VALUES (?, ?, ?, ?)
  `);

  const saveAll = db.transaction((results) => {
    for (const r of results) {
      for (const item of (r.items || [])) {
        if (item.status === 'error' || item.status === 'warn') {
          // 패턴 분석 제외 레이블 스킵
          if (PATTERN_SKIP_LABELS.includes(item.label.trim())) continue;
          insert.run(r.name, item.label.trim(), item.status, item.detail || '');
        }
      }
    }
  });

  try {
    saveAll(results);
  } catch { /* DB 없으면 무시 */ }
}

/**
 * 반복 오류 패턴 조회 (최근 N일 내 M회 이상 반복)
 * @param {number} days      조회 기간 (일)
 * @param {number} minCount  최소 반복 횟수
 * @returns {Array} [{ check_name, label, cnt, last_seen, worst_status }]
 */
function getPatterns(days = 7, minCount = 3) {
  const db = getDb();
  if (!db) return [];
  try {
    return db.prepare(`
      SELECT
        check_name,
        label,
        COUNT(*)          AS cnt,
        MAX(detected_at)  AS last_seen,
        MAX(CASE status WHEN 'error' THEN 2 WHEN 'warn' THEN 1 ELSE 0 END) AS severity
      FROM dexter_error_log
      WHERE detected_at > datetime('now', ? || ' days')
        AND status IN ('error', 'warn')
      GROUP BY check_name, label
      HAVING cnt >= ?
      ORDER BY severity DESC, cnt DESC
      LIMIT 20
    `).all(`-${days}`, minCount);
  } catch { return []; }
}

/**
 * 현재 ok인 항목의 과거 오류 이력 삭제 (오류 해결 시 패턴 누적 방지)
 *
 * 설계 의도: saveErrorItems는 error/warn만 저장하므로, ok로 돌아온 항목의
 * 이전 error 레코드가 DB에 그대로 남아 "지속적 오탐"으로 나타나는 문제를 해결.
 * saveErrorItems 호출 직전에 실행해야 함.
 *
 * @param {Array} results  dexter check results []
 * @returns {number} 삭제된 행 수
 */
function markResolved(results) {
  const db = getDb();
  if (!db) return 0;
  let total = 0;
  try {
    const del = db.prepare(`DELETE FROM dexter_error_log WHERE check_name = ? AND label = ?`);
    const run = db.transaction(() => {
      for (const r of results) {
        for (const item of (r.items || [])) {
          if (item.status === 'ok') {
            total += del.run(r.name, item.label.trim()).changes;
          }
        }
      }
    });
    run();
  } catch { /* DB 없으면 무시 */ }
  return total;
}

/**
 * 해결된 이슈 이력 삭제
 * @param {string|null} label  특정 레이블만 삭제 (null이면 모두)
 * @param {string|null} checkName  특정 체크 모듈만 삭제
 * @returns {number} 삭제된 행 수
 */
function clearPatterns(label = null, checkName = null) {
  const db = getDb();
  if (!db) return 0;
  try {
    if (label && checkName) {
      return db.prepare(`DELETE FROM dexter_error_log WHERE check_name=? AND label=?`).run(checkName, label).changes;
    } else if (label) {
      return db.prepare(`DELETE FROM dexter_error_log WHERE label LIKE ?`).run(`%${label}%`).changes;
    } else if (checkName) {
      return db.prepare(`DELETE FROM dexter_error_log WHERE check_name=?`).run(checkName).changes;
    } else {
      return db.prepare(`DELETE FROM dexter_error_log`).run().changes;
    }
  } catch { return 0; }
}

/**
 * 최근 첫 등장 오류 조회 (이전 기간에는 없었고 최근에 등장)
 * @param {number} recentHours   최근 범위 (시간)
 * @param {number} prevDays      비교 대상 과거 기간 (일)
 * @returns {Array} [{ check_name, label, status, detail, detected_at }]
 */
function getNewErrors(recentHours = 8, prevDays = 7) {
  const db = getDb();
  if (!db) return [];
  try {
    // 최근 recentHours 내 등장했고, 그 이전 prevDays에는 없었던 항목
    // GROUP BY로 중복 제거 (detected_at이 달라도 같은 이슈는 1건으로)
    return db.prepare(`
      SELECT check_name, label, status,
             MIN(detail)       AS detail,
             MIN(detected_at)  AS detected_at
      FROM dexter_error_log
      WHERE detected_at > datetime('now', ? || ' hours')
        AND status IN ('error', 'warn')
        AND (check_name || '|' || label) NOT IN (
          SELECT check_name || '|' || label
          FROM dexter_error_log
          WHERE detected_at <= datetime('now', ? || ' hours')
            AND detected_at > datetime('now', ? || ' days')
        )
      GROUP BY check_name, label, status
      ORDER BY detected_at ASC
      LIMIT 10
    `).all(`-${recentHours}`, `-${recentHours}`, `-${prevDays}`);
  } catch { return []; }
}

/**
 * 오래된 이력 삭제 (keepDays일 이전 항목 제거)
 */
function cleanup(keepDays = 30) {
  const db = getDb();
  if (!db) return 0;
  try {
    const r = db.prepare(`
      DELETE FROM dexter_error_log
      WHERE detected_at < datetime('now', ? || ' days')
    `).run(`-${keepDays}`);
    return r.changes;
  } catch { return 0; }
}

module.exports = { saveErrorItems, markResolved, getPatterns, getNewErrors, cleanup, clearPatterns };
