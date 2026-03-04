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
 * 최근 첫 등장 오류 조회 (이전 기간에는 없었고 최근에 등장)
 * @param {number} recentHours   최근 범위 (시간)
 * @param {number} prevDays      비교 대상 과거 기간 (일)
 * @returns {Array} [{ check_name, label, status, detail, detected_at }]
 */
function getNewErrors(recentHours = 24, prevDays = 7) {
  const db = getDb();
  if (!db) return [];
  try {
    // 최근 recentHours 내 등장했고, 그 이전 prevDays에는 없었던 항목
    return db.prepare(`
      SELECT DISTINCT check_name, label, status, detail, detected_at
      FROM dexter_error_log
      WHERE detected_at > datetime('now', ? || ' hours')
        AND status IN ('error', 'warn')
        AND (check_name || '|' || label) NOT IN (
          SELECT check_name || '|' || label
          FROM dexter_error_log
          WHERE detected_at <= datetime('now', ? || ' hours')
            AND detected_at > datetime('now', ? || ' days')
        )
      ORDER BY detected_at DESC
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

module.exports = { saveErrorItems, getPatterns, getNewErrors, cleanup };
