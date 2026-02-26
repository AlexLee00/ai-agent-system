'use strict';

/**
 * lib/db.js — SQLite 단일 상태 DB (WAL 모드, 도메인 함수 포함)
 *
 * 위치: ~/.openclaw/workspace/state.db
 * 모든 봇이 공유하는 단일 파일 (맥미니 이전 시 이 파일만 복사)
 *
 * 암호화: lib/crypto.js (AES-256-GCM)
 * 암호화 대상: reservations.name_enc, phone_raw_enc
 *              kiosk_blocks.name_enc, phone_raw_enc
 */

const path = require('path');
const { encrypt, decrypt, hashKioskKey } = require('./crypto');

const DB_PATH = path.join(process.env.HOME, '.openclaw', 'workspace', 'state.db');

let _db = null;

// ─── 초기화 ────────────────────────────────────────────────────────

function getDb() {
  if (_db) return _db;
  const Database = require('better-sqlite3');
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.pragma('foreign_keys = ON');
  _initSchema(_db);
  return _db;
}

function _initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reservations (
      id TEXT PRIMARY KEY,
      composite_key TEXT,
      name_enc TEXT,
      phone TEXT,
      phone_raw_enc TEXT,
      date TEXT,
      start_time TEXT,
      end_time TEXT,
      room TEXT,
      status TEXT DEFAULT 'pending',
      pickko_status TEXT,
      pickko_order_id TEXT,
      error_reason TEXT,
      retries INTEGER DEFAULT 0,
      detected_at TEXT,
      pickko_start_time TEXT,
      pickko_complete_time TEXT,
      marked_seen INTEGER DEFAULT 0,
      seen_only INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cancelled_keys (
      cancel_key TEXT PRIMARY KEY,
      cancelled_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kiosk_blocks (
      id TEXT PRIMARY KEY,
      phone_raw_enc TEXT,
      name_enc TEXT,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT,
      room TEXT,
      amount INTEGER DEFAULT 0,
      naver_blocked INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT,
      blocked_at TEXT,
      naver_unblocked_at TEXT
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      type TEXT,
      title TEXT,
      message TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      sent_at TEXT,
      resolved INTEGER NOT NULL DEFAULT 0,
      resolved_at TEXT,
      phone TEXT,
      date TEXT,
      start_time TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_res_status ON reservations(status);
    CREATE INDEX IF NOT EXISTS idx_res_date   ON reservations(date);
    CREATE INDEX IF NOT EXISTS idx_kiosk_date ON kiosk_blocks(date);
    CREATE INDEX IF NOT EXISTS idx_alerts_ts  ON alerts(timestamp);
  `);
}

// ─── reservations ──────────────────────────────────────────────────

/**
 * ID가 reservations에 존재하고 marked_seen=1 OR seen_only=1인지 확인
 * → naver-monitor.js의 seenSet.has(id) 대체
 */
function isSeenId(id) {
  const db = getDb();
  const row = db.prepare(
    'SELECT marked_seen, seen_only FROM reservations WHERE id = ?'
  ).get(id);
  return !!row && (row.marked_seen === 1 || row.seen_only === 1);
}

/**
 * 예약 ID를 "seen" 처리 (재처리 방지)
 * - 이미 행이 있으면 marked_seen=1 업데이트
 * - 행이 없으면 seen_only=1 최소 행 삽입
 */
function markSeen(id) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM reservations WHERE id = ?').get(id);
  if (existing) {
    db.prepare(
      "UPDATE reservations SET marked_seen=1, updated_at=datetime('now') WHERE id=?"
    ).run(id);
  } else {
    db.prepare(
      'INSERT OR IGNORE INTO reservations(id, date, start_time, seen_only) VALUES(?,?,?,1)'
    ).run(id, '', '');
  }
}

/**
 * 신규 예약 추가 (name, phoneRaw 자동 암호화)
 * data = { compositeKey, name, phone, phoneRaw, date, start, end, room,
 *           detectedAt, status, pickkoStatus, pickkoOrderId, errorReason, retries }
 */
function addReservation(id, data) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO reservations
      (id, composite_key, name_enc, phone, phone_raw_enc,
       date, start_time, end_time, room, status,
       pickko_status, pickko_order_id, error_reason, retries,
       detected_at, pickko_start_time, pickko_complete_time,
       marked_seen, seen_only, updated_at)
    VALUES
      (@id, @composite_key, @name_enc, @phone, @phone_raw_enc,
       @date, @start_time, @end_time, @room, @status,
       @pickko_status, @pickko_order_id, @error_reason, @retries,
       @detected_at, @pickko_start_time, @pickko_complete_time,
       0, 0, datetime('now'))
  `).run({
    id,
    composite_key:       data.compositeKey || null,
    name_enc:            encrypt(data.name || null),
    phone:               data.phone || null,
    phone_raw_enc:       encrypt(data.phoneRaw || null),
    date:                data.date || '',
    start_time:          data.start || '',
    end_time:            data.end || null,
    room:                data.room || null,
    status:              data.status || 'pending',
    pickko_status:       data.pickkoStatus || null,
    pickko_order_id:     data.pickkoOrderId || null,
    error_reason:        data.errorReason || null,
    retries:             data.retries || 0,
    detected_at:         data.detectedAt || null,
    pickko_start_time:   data.pickkoStartTime || null,
    pickko_complete_time: data.pickkoCompleteTime || null,
  });
}

/**
 * 예약 상태 업데이트 (부분 업데이트)
 * updates = { status, pickkoStatus, pickkoOrderId, errorReason, retries,
 *             pickkoStartTime, pickkoCompleteTime }
 */
function updateReservation(id, updates) {
  const db = getDb();
  const sets = [];
  const params = {};

  const fieldMap = {
    status:             'status',
    pickkoStatus:       'pickko_status',
    pickkoOrderId:      'pickko_order_id',
    errorReason:        'error_reason',
    retries:            'retries',
    pickkoStartTime:    'pickko_start_time',
    pickkoCompleteTime: 'pickko_complete_time',
  };

  for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
    if (jsKey in updates) {
      sets.push(`${dbCol} = @${dbCol}`);
      params[dbCol] = updates[jsKey];
    }
  }

  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  params.id = id;

  db.prepare(`UPDATE reservations SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

/**
 * 예약 정보 조회 (name, phoneRaw 자동 복호화)
 * → { id, compositeKey, name, phone, phoneRaw, date, start, end, room,
 *     status, pickkoStatus, ... }
 */
function getReservation(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM reservations WHERE id = ?').get(id);
  return row ? _decryptRow(row) : null;
}

/**
 * pending/processing/failed 상태 예약 목록 반환
 */
function getPendingReservations() {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM reservations WHERE status IN ('pending','processing','failed') AND seen_only=0"
  ).all().map(_decryptRow);
}

/**
 * pickko-daily-audit의 collectNaverKeys() 대체
 * → Set<"phoneRaw|date|startTime">
 */
function getAllNaverKeys() {
  const db = getDb();
  const rows = db.prepare(
    'SELECT phone_raw_enc, date, start_time FROM reservations WHERE seen_only=0 AND date != ?'
  ).all('');
  const keys = new Set();
  for (const row of rows) {
    const phoneRaw = decrypt(row.phone_raw_enc);
    if (phoneRaw && row.date && row.start_time) {
      keys.add(`${phoneRaw}|${row.date}|${row.start_time}`);
    }
  }
  return keys;
}

/**
 * processing 상태 항목 → failed 롤백 (프로세스 강제 종료 대비)
 */
function rollbackProcessing() {
  const db = getDb();
  const result = db.prepare(`
    UPDATE reservations
    SET status='failed', error_reason='프로세스 강제 종료 (rollback)', updated_at=datetime('now')
    WHERE status='processing'
  `).run();
  return result.changes;
}

/**
 * cutoffDate(YYYY-MM-DD) 이전 예약 삭제 (개인정보 보호)
 */
function pruneOldReservations(cutoffDate) {
  const db = getDb();
  const result = db.prepare(
    "DELETE FROM reservations WHERE date != '' AND date < ?"
  ).run(cutoffDate);
  return result.changes;
}

// ─── cancelled_keys ────────────────────────────────────────────────

function isCancelledKey(cancelKey) {
  const db = getDb();
  return !!db.prepare('SELECT 1 FROM cancelled_keys WHERE cancel_key = ?').get(cancelKey);
}

function addCancelledKey(cancelKey) {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO cancelled_keys(cancel_key, cancelled_at) VALUES(?, datetime('now'))"
  ).run(cancelKey);
}

function pruneOldCancelledKeys(cutoffDate) {
  const db = getDb();
  const result = db.prepare('DELETE FROM cancelled_keys WHERE cancelled_at < ?').run(cutoffDate);
  return result.changes;
}

// ─── kiosk_blocks ──────────────────────────────────────────────────

/**
 * kiosk block 조회 (phoneRaw, date, start → 해시 키로 조회)
 */
function getKioskBlock(phoneRaw, date, start) {
  const db = getDb();
  const id = hashKioskKey(phoneRaw, date, start);
  const row = db.prepare('SELECT * FROM kiosk_blocks WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    phoneRaw:       decrypt(row.phone_raw_enc),
    name:           decrypt(row.name_enc),
    naverBlocked:   row.naver_blocked === 1,
    firstSeenAt:    row.first_seen_at,
    blockedAt:      row.blocked_at,
    naverUnblockedAt: row.naver_unblocked_at,
    start:          row.start_time,
    end:            row.end_time,
  };
}

/**
 * kiosk block upsert (해시 키 자동 계산)
 * data = { name, phoneRaw, date, start, end, room, amount,
 *          naverBlocked, firstSeenAt, blockedAt, naverUnblockedAt }
 */
function upsertKioskBlock(phoneRaw, date, start, data) {
  const db = getDb();
  const id = hashKioskKey(phoneRaw, date, start);
  db.prepare(`
    INSERT INTO kiosk_blocks
      (id, phone_raw_enc, name_enc, date, start_time, end_time, room,
       amount, naver_blocked, first_seen_at, blocked_at, naver_unblocked_at)
    VALUES
      (@id, @phone_raw_enc, @name_enc, @date, @start_time, @end_time, @room,
       @amount, @naver_blocked, @first_seen_at, @blocked_at, @naver_unblocked_at)
    ON CONFLICT(id) DO UPDATE SET
      name_enc           = excluded.name_enc,
      end_time           = excluded.end_time,
      room               = excluded.room,
      amount             = excluded.amount,
      naver_blocked      = excluded.naver_blocked,
      first_seen_at      = COALESCE(first_seen_at, excluded.first_seen_at),
      blocked_at         = excluded.blocked_at,
      naver_unblocked_at = excluded.naver_unblocked_at
  `).run({
    id,
    phone_raw_enc:    encrypt(phoneRaw),
    name_enc:         encrypt(data.name || null),
    date:             data.date || date,
    start_time:       data.start || start,
    end_time:         data.end || null,
    room:             data.room || null,
    amount:           data.amount || 0,
    naver_blocked:    data.naverBlocked ? 1 : 0,
    first_seen_at:    data.firstSeenAt || null,
    blocked_at:       data.blockedAt || null,
    naver_unblocked_at: data.naverUnblockedAt || null,
  });
}

/**
 * naverBlocked=true이고 naverUnblockedAt이 없는 블록 목록 반환
 */
function getBlockedKioskBlocks() {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM kiosk_blocks WHERE naver_blocked=1 AND naver_unblocked_at IS NULL'
  ).all().map(row => ({
    ...row,
    phoneRaw:     decrypt(row.phone_raw_enc),
    name:         decrypt(row.name_enc),
    naverBlocked: row.naver_blocked === 1,
    firstSeenAt:  row.first_seen_at,
    blockedAt:    row.blocked_at,
    start:        row.start_time,
    end:          row.end_time,
  }));
}

/**
 * beforeDate 이전 kiosk_blocks 삭제
 */
function pruneOldKioskBlocks(beforeDate) {
  const db = getDb();
  const result = db.prepare('DELETE FROM kiosk_blocks WHERE date < ?').run(beforeDate);
  return result.changes;
}

// ─── alerts ────────────────────────────────────────────────────────

/**
 * 알림 추가
 * data = { timestamp, type, title, message, phone, date, startTime, resolved, resolvedAt }
 * → 생성된 row id 반환
 */
function addAlert(data) {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO alerts
      (timestamp, type, title, message, sent, sent_at, resolved, resolved_at, phone, date, start_time)
    VALUES
      (@timestamp, @type, @title, @message, 0, NULL, @resolved, @resolved_at, @phone, @date, @start_time)
  `).run({
    timestamp:   data.timestamp || new Date().toISOString(),
    type:        data.type || 'info',
    title:       data.title || null,
    message:     data.message,
    resolved:    data.resolved || 0,
    resolved_at: data.resolvedAt || null,
    phone:       data.phone || null,
    date:        data.date || null,
    start_time:  data.startTime || null,
  });
  return result.lastInsertRowid;
}

/**
 * 알림 전송 성공 시 sent=1, sent_at 업데이트
 */
function updateAlertSent(alertId, sentAt) {
  const db = getDb();
  db.prepare(
    "UPDATE alerts SET sent=1, sent_at=? WHERE id=?"
  ).run(sentAt || new Date().toISOString(), alertId);
}

/**
 * 특정 예약의 미해결(resolved=0, type='error') 알림 → resolved=1 처리
 * → 처리된 건수 반환
 */
function resolveAlert(phone, date, start) {
  const db = getDb();
  const result = db.prepare(`
    UPDATE alerts
    SET resolved=1, resolved_at=datetime('now')
    WHERE resolved=0 AND type='error'
      AND phone=? AND date=? AND start_time=?
  `).run(phone, date, start);
  return result.changes;
}

/**
 * 미해결 오류 알림 목록 반환 (reportUnresolvedAlerts용)
 */
function getUnresolvedAlerts() {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM alerts WHERE resolved=0 AND type='error' ORDER BY timestamp ASC"
  ).all();
}

/**
 * 30일 초과 알림 삭제 (해결됨 48h, 미해결 7일 기준 유지)
 * resolved=1 → 48시간 초과 삭제
 * resolved=0 → 7일 초과 삭제
 */
function pruneOldAlerts() {
  const db = getDb();
  const now = new Date().toISOString();
  const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const cutoff7d  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const r1 = db.prepare('DELETE FROM alerts WHERE resolved=1 AND timestamp < ?').run(cutoff48h);
  const r2 = db.prepare('DELETE FROM alerts WHERE resolved=0 AND timestamp < ?').run(cutoff7d);
  return r1.changes + r2.changes;
}

// ─── 내부 유틸 ─────────────────────────────────────────────────────

function _decryptRow(row) {
  return {
    id:                 row.id,
    compositeKey:       row.composite_key,
    name:               _safeDec(row.name_enc),
    phone:              row.phone,
    phoneRaw:           _safeDec(row.phone_raw_enc),
    date:               row.date,
    start:              row.start_time,
    end:                row.end_time,
    room:               row.room,
    status:             row.status,
    pickkoStatus:       row.pickko_status,
    pickkoOrderId:      row.pickko_order_id,
    errorReason:        row.error_reason,
    retries:            row.retries,
    detectedAt:         row.detected_at,
    pickkoStartTime:    row.pickko_start_time,
    pickkoCompleteTime: row.pickko_complete_time,
    markedSeen:         row.marked_seen === 1,
    seenOnly:           row.seen_only === 1,
  };
}

function _safeDec(val) {
  if (!val) return null;
  try { return decrypt(val); } catch (e) { return null; }
}

module.exports = {
  getDb,
  // reservations
  isSeenId,
  markSeen,
  addReservation,
  updateReservation,
  getReservation,
  getPendingReservations,
  getAllNaverKeys,
  rollbackProcessing,
  pruneOldReservations,
  // cancelled_keys
  isCancelledKey,
  addCancelledKey,
  pruneOldCancelledKeys,
  // kiosk_blocks
  getKioskBlock,
  upsertKioskBlock,
  getBlockedKioskBlocks,
  pruneOldKioskBlocks,
  // alerts
  addAlert,
  updateAlertSent,
  resolveAlert,
  getUnresolvedAlerts,
  pruneOldAlerts,
};
