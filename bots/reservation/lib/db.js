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
  // schema_migrations 테이블은 항상 먼저 생성
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      name        TEXT NOT NULL,
      applied_at  TEXT DEFAULT (datetime('now'))
    )
  `);

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

    CREATE TABLE IF NOT EXISTS daily_summary (
      date TEXT PRIMARY KEY,
      total_amount INTEGER DEFAULT 0,
      room_amounts_json TEXT,
      entries_count INTEGER DEFAULT 0,
      pickko_total INTEGER DEFAULT 0,
      pickko_study_room INTEGER DEFAULT 0,
      general_revenue INTEGER DEFAULT 0,
      reported_at TEXT,
      last_reported_at TEXT,
      confirmed INTEGER DEFAULT 0,
      confirmed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS room_revenue (
      room TEXT NOT NULL,
      date TEXT NOT NULL,
      amount INTEGER DEFAULT 0,
      confirmed_at TEXT,
      PRIMARY KEY (room, date)
    );

    CREATE TABLE IF NOT EXISTS naver_future_confirmed (
      booking_key  TEXT PRIMARY KEY,
      phone_raw    TEXT NOT NULL,
      date         TEXT NOT NULL,
      start_time   TEXT NOT NULL,
      end_time     TEXT NOT NULL,
      room         TEXT,
      last_scan    INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_res_status ON reservations(status);
    CREATE INDEX IF NOT EXISTS idx_res_date   ON reservations(date);
    CREATE INDEX IF NOT EXISTS idx_kiosk_date ON kiosk_blocks(date);
    CREATE INDEX IF NOT EXISTS idx_alerts_ts  ON alerts(timestamp);
    CREATE INDEX IF NOT EXISTS idx_nfc_date   ON naver_future_confirmed(date);
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
 * completed 상태이지만 pickkoStatus가 verified/manual/time_elapsed가 아닌 항목 반환
 * (paid, auto 등 — 픽코 재검증 필요)
 */
function getUnverifiedCompletedReservations() {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM reservations WHERE status='completed' AND seen_only=0 AND (pickko_status IS NULL OR pickko_status NOT IN ('verified','manual','time_elapsed'))"
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
 * 특정 날짜의 naverBlocked=true 항목 전체 반환 (오늘 예약 검증용)
 */
function getKioskBlocksForDate(date) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM kiosk_blocks WHERE date = ? AND naver_blocked = 1 AND naver_unblocked_at IS NULL'
  ).all(date).map(row => ({
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

// ─── daily_summary ─────────────────────────────────────────────────

/**
 * 일별 요약 upsert
 * data = { totalAmount, roomAmounts, entriesCount }
 */
function upsertDailySummary(date, data) {
  const db = getDb();
  const nowISO = new Date().toISOString();
  const roomJson = JSON.stringify(data.roomAmounts || {});
  db.prepare(`
    INSERT INTO daily_summary (date, total_amount, room_amounts_json, entries_count,
      pickko_total, pickko_study_room, general_revenue, reported_at, last_reported_at, confirmed, confirmed_at)
    VALUES (@date, @total_amount, @room_amounts_json, @entries_count,
      @pickko_total, @pickko_study_room, @general_revenue, @now, @now, 0, NULL)
    ON CONFLICT(date) DO UPDATE SET
      total_amount       = excluded.total_amount,
      room_amounts_json  = excluded.room_amounts_json,
      entries_count      = excluded.entries_count,
      pickko_total       = excluded.pickko_total,
      pickko_study_room  = excluded.pickko_study_room,
      general_revenue    = excluded.general_revenue,
      last_reported_at   = excluded.last_reported_at
  `).run({
    date,
    total_amount:      data.totalAmount || 0,
    room_amounts_json: roomJson,
    entries_count:     data.entriesCount || 0,
    pickko_total:      data.pickkoTotal || 0,
    pickko_study_room: data.pickkoStudyRoom || 0,
    general_revenue:   data.generalRevenue || 0,
    now:               nowISO,
  });
}

/**
 * 날짜별 요약 조회
 */
function getDailySummary(date) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM daily_summary WHERE date = ?').get(date);
  if (!row) return null;
  return {
    ...row,
    roomAmounts:     JSON.parse(row.room_amounts_json || '{}'),
    pickkoTotal:     row.pickko_total || 0,
    pickkoStudyRoom: row.pickko_study_room || 0,
    generalRevenue:  row.general_revenue || 0,
    confirmed:       row.confirmed === 1,
  };
}

/**
 * cutoff(YYYY-MM-DD) 이전 중 미컨펌 요약 1건 (가장 최근) 반환
 */
function getUnconfirmedSummaryBefore(cutoffDate) {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM daily_summary WHERE date < ? AND confirmed = 0 ORDER BY date DESC LIMIT 1"
  ).get(cutoffDate);
  if (!row) return null;
  return {
    ...row,
    roomAmounts:     JSON.parse(row.room_amounts_json || '{}'),
    pickkoTotal:     row.pickko_total || 0,
    pickkoStudyRoom: row.pickko_study_room || 0,
    generalRevenue:  row.general_revenue || 0,
    confirmed:       false,
  };
}

/**
 * 미컨펌 요약 중 가장 최근 1건 반환 (날짜 무관)
 */
function getLatestUnconfirmedSummary() {
  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM daily_summary WHERE confirmed = 0 ORDER BY date DESC LIMIT 1"
  ).get();
  if (!row) return null;
  return {
    ...row,
    roomAmounts:     JSON.parse(row.room_amounts_json || '{}'),
    pickkoTotal:     row.pickko_total || 0,
    pickkoStudyRoom: row.pickko_study_room || 0,
    generalRevenue:  row.general_revenue || 0,
    confirmed:       false,
  };
}

/**
 * 컨펌 처리 — daily_summary.confirmed=1 + room_revenue 누적
 * 반환: { date, totalAmount, roomAmounts }
 */
function confirmDailySummary(date) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM daily_summary WHERE date = ?').get(date);
  if (!row) return null;

  const nowISO = new Date().toISOString();
  const roomAmounts = JSON.parse(row.room_amounts_json || '{}');

  db.transaction(() => {
    // 1. daily_summary 컨펌 처리
    db.prepare(
      "UPDATE daily_summary SET confirmed=1, confirmed_at=? WHERE date=?"
    ).run(nowISO, date);

    // 2. room_revenue 누적 upsert (스터디룸)
    for (const [room, amount] of Object.entries(roomAmounts)) {
      db.prepare(`
        INSERT INTO room_revenue (room, date, amount, confirmed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(room, date) DO UPDATE SET
          amount       = excluded.amount,
          confirmed_at = excluded.confirmed_at
      `).run(room, date, amount, nowISO);
    }

    // 3. room_revenue 누적 upsert (일반이용 — 픽코 키오스크 일반 이용)
    if (row.general_revenue > 0) {
      db.prepare(`
        INSERT INTO room_revenue (room, date, amount, confirmed_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(room, date) DO UPDATE SET
          amount       = excluded.amount,
          confirmed_at = excluded.confirmed_at
      `).run('일반이용', date, row.general_revenue, nowISO);
    }
  })();

  return { date, totalAmount: row.total_amount, roomAmounts, generalRevenue: row.general_revenue || 0 };
}

/**
 * 기간 내 daily_summary 행 목록 조회
 * @param {string} startDate YYYY-MM-DD
 * @param {string} endDate   YYYY-MM-DD (inclusive)
 * @returns {Array}
 */
function getDailySummariesInRange(startDate, endDate) {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM daily_summary WHERE date >= ? AND date <= ? ORDER BY date"
  ).all(startDate, endDate).map(row => ({
    ...row,
    roomAmounts:     JSON.parse(row.room_amounts_json || '{}'),
    pickkoTotal:     row.pickko_total || 0,
    pickkoStudyRoom: row.pickko_study_room || 0,
    generalRevenue:  row.general_revenue || 0,
    confirmed:       row.confirmed === 1,
  }));
}

// ─── room_revenue ───────────────────────────────────────────────────

/**
 * 스터디룸별 누적 매출 조회 (전체 기간)
 * 반환: [{ room, totalAmount, days }]
 */
function getRoomRevenueSummary() {
  const db = getDb();
  return db.prepare(
    "SELECT room, SUM(amount) as total_amount, COUNT(*) as days FROM room_revenue GROUP BY room ORDER BY room"
  ).all();
}

/**
 * 오늘 예약 현황 집계 (네이버 + 키오스크)
 * @param {string} date — 'YYYY-MM-DD'
 * @returns {{ naverTotal, naverConfirmed, kioskTotal, total }}
 */
function getTodayStats(date) {
  const db = getDb();
  const naverTotal     = db.prepare(
    "SELECT COUNT(*) as cnt FROM reservations WHERE date=? AND seen_only=0 AND status NOT IN ('failed')"
  ).get(date)?.cnt ?? 0;
  const naverConfirmed = db.prepare(
    "SELECT COUNT(*) as cnt FROM reservations WHERE date=? AND seen_only=0 AND status='completed'"
  ).get(date)?.cnt ?? 0;
  const kioskTotal     = db.prepare(
    'SELECT COUNT(*) as cnt FROM kiosk_blocks WHERE date=?'
  ).get(date)?.cnt ?? 0;
  return { naverTotal, naverConfirmed, kioskTotal, total: naverTotal + kioskTotal };
}

// ─── naver_future_confirmed (미래 예약 스냅샷) ─────────────────────

/**
 * 미래 예약 스냅샷 upsert (3사이클마다 갱신)
 * - bookingKey: bookingId 또는 "date|start|end|room|phone" 복합키
 * - scanCycle: 현재 checkCount (last_scan 갱신용)
 */
function upsertFutureConfirmed(bookingKey, phoneRaw, date, startTime, endTime, room, scanCycle) {
  const db = getDb();
  db.prepare(`
    INSERT INTO naver_future_confirmed
      (booking_key, phone_raw, date, start_time, end_time, room, last_scan)
    VALUES
      (@booking_key, @phone_raw, @date, @start_time, @end_time, @room, @last_scan)
    ON CONFLICT(booking_key) DO UPDATE SET
      phone_raw  = excluded.phone_raw,
      date       = excluded.date,
      start_time = excluded.start_time,
      end_time   = excluded.end_time,
      room       = excluded.room,
      last_scan  = excluded.last_scan
  `).run({
    booking_key: bookingKey,
    phone_raw:   phoneRaw || '',
    date:        date || '',
    start_time:  startTime || '',
    end_time:    endTime || '',
    room:        room || null,
    last_scan:   scanCycle || 0,
  });
}

/**
 * stale(사라진) 예약 조회: last_scan < currentCycle AND date >= minDate
 * → 이번 스캔에서 갱신되지 않은 = 네이버에서 사라짐 = 취소 가능성
 */
function getStaleConfirmed(currentCycle, minDate) {
  const db = getDb();
  return db.prepare(
    'SELECT * FROM naver_future_confirmed WHERE last_scan < ? AND date >= ?'
  ).all(currentCycle, minDate || '');
}

/**
 * stale 항목 일괄 삭제 (취소 처리 완료 후 호출)
 * - currentCycle, minDate 조건은 getStaleConfirmed와 동일
 */
function deleteStaleConfirmed(currentCycle, minDate) {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM naver_future_confirmed WHERE last_scan < ? AND date >= ?'
  ).run(currentCycle, minDate || '');
  return result.changes;
}

/**
 * cutoffDate 이전 스냅샷 삭제 (과거 날짜 정리)
 */
function pruneOldFutureConfirmed(cutoffDate) {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM naver_future_confirmed WHERE date < ?'
  ).run(cutoffDate);
  return result.changes;
}

// ─── 마이그레이션 헬퍼 ─────────────────────────────────────────────

/** schema_migrations 테이블 생성 (이미 _initSchema에서 처리, 단독 호출용) */
function initMigrationsTable() {
  const db = getDb(); // getDb()가 _initSchema()를 호출하므로 테이블은 이미 생성됨
  return db;
}

/** 적용된 마이그레이션 버전 Set 반환 */
function getAppliedMigrations() {
  const db = getDb();
  const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all();
  return new Set(rows.map(r => r.version));
}

/** 마이그레이션 이력 기록 */
function recordMigration(version, name) {
  const db = getDb();
  db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)"
  ).run(version, name);
}

/**
 * 취소 감지 3 (DB 크로스체크)용
 * fromDate(YYYY-MM-DD) 이후 미래 날짜 중 픽코 등록 완료된 예약 반환
 * → 현재 네이버 확정 리스트에 없으면 취소로 간주
 */
function getFuturePickkoRegistered(fromDate) {
  const db = getDb();
  const rows = db.prepare(
    "SELECT * FROM reservations WHERE date >= ? AND status='completed' AND seen_only=0 AND (pickko_status IS NULL OR pickko_status NOT IN ('cancelled','manual','time_elapsed'))"
  ).all(fromDate);
  return rows.map(_decryptRow);
}

/** 현재 스키마 버전 반환 (최대 version) */
function getSchemaVersion() {
  const db = getDb();
  const row = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get();
  return row?.v ?? 0;
}

module.exports = {
  getDb,
  // 마이그레이션
  initMigrationsTable, getAppliedMigrations, recordMigration, getSchemaVersion,
  // reservations
  isSeenId,
  markSeen,
  addReservation,
  updateReservation,
  getReservation,
  getPendingReservations,
  getUnverifiedCompletedReservations,
  getAllNaverKeys,
  getFuturePickkoRegistered,
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
  getKioskBlocksForDate,
  pruneOldKioskBlocks,
  // alerts
  addAlert,
  updateAlertSent,
  resolveAlert,
  getUnresolvedAlerts,
  pruneOldAlerts,
  // daily_summary
  upsertDailySummary,
  getDailySummary,
  getDailySummariesInRange,
  getUnconfirmedSummaryBefore,
  getLatestUnconfirmedSummary,
  confirmDailySummary,
  // room_revenue
  getRoomRevenueSummary,
  // stats
  getTodayStats,
  // naver_future_confirmed (Detection 4)
  upsertFutureConfirmed,
  getStaleConfirmed,
  deleteStaleConfirmed,
  pruneOldFutureConfirmed,
};
