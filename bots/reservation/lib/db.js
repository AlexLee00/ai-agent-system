'use strict';

/**
 * lib/db.js — PostgreSQL reservation 스키마 (Phase 3 마이그레이션 완료)
 *
 * 위치: PostgreSQL jay DB, reservation 스키마
 * 모든 봇이 공유하는 단일 DB
 *
 * 암호화: lib/crypto.js (AES-256-GCM)
 * 암호화 대상: reservations.name_enc, phone_raw_enc
 *              kiosk_blocks.name_enc, phone_raw_enc
 */

const { encrypt, decrypt, hashKioskKey } = require('./crypto');
const pgPool = require('../../../packages/core/lib/pg-pool');

const SCHEMA = 'reservation';

// ─── reservations ──────────────────────────────────────────────────

/**
 * ID가 reservations에 존재하고 marked_seen=1 OR seen_only=1인지 확인
 */
async function isSeenId(id) {
  const row = await pgPool.get(SCHEMA,
    'SELECT marked_seen, seen_only FROM reservations WHERE id = $1', [id]);
  return !!row && (row.marked_seen === 1 || row.seen_only === 1);
}

/**
 * 예약 ID를 "seen" 처리 (재처리 방지)
 */
async function markSeen(id) {
  const existing = await pgPool.get(SCHEMA, 'SELECT id FROM reservations WHERE id = $1', [id]);
  if (existing) {
    await pgPool.run(SCHEMA,
      "UPDATE reservations SET marked_seen=1, updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS') WHERE id=$1", [id]);
  } else {
    await pgPool.run(SCHEMA,
      'INSERT INTO reservations(id, date, start_time, seen_only) VALUES($1,$2,$3,1) ON CONFLICT DO NOTHING',
      [id, '', '']);
  }
}

/**
 * 신규 예약 추가 (name, phoneRaw 자동 암호화)
 */
async function addReservation(id, data) {
  try {
    await pgPool.run(SCHEMA, `
      INSERT INTO reservations
        (id, composite_key, name_enc, phone, phone_raw_enc,
         date, start_time, end_time, room, status,
         pickko_status, pickko_order_id, error_reason, retries,
         detected_at, pickko_start_time, pickko_complete_time,
         marked_seen, seen_only, updated_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,0,0,to_char(now(),'YYYY-MM-DD HH24:MI:SS'))
      ON CONFLICT(id) DO UPDATE SET
        composite_key        = EXCLUDED.composite_key,
        name_enc             = EXCLUDED.name_enc,
        phone                = EXCLUDED.phone,
        phone_raw_enc        = EXCLUDED.phone_raw_enc,
        date                 = EXCLUDED.date,
        start_time           = EXCLUDED.start_time,
        end_time             = EXCLUDED.end_time,
        room                 = EXCLUDED.room,
        status               = EXCLUDED.status,
        pickko_status        = EXCLUDED.pickko_status,
        pickko_order_id      = EXCLUDED.pickko_order_id,
        error_reason         = EXCLUDED.error_reason,
        retries              = EXCLUDED.retries,
        detected_at          = EXCLUDED.detected_at,
        pickko_start_time    = EXCLUDED.pickko_start_time,
        pickko_complete_time = EXCLUDED.pickko_complete_time,
        updated_at           = to_char(now(),'YYYY-MM-DD HH24:MI:SS')
    `, [
      id,
      data.compositeKey      || null,
      encrypt(data.name      || null),
      data.phone             || null,
      encrypt(data.phoneRaw  || null),
      data.date              || '',
      data.start             || '',
      data.end               || null,
      data.room              || null,
      data.status            || 'pending',
      data.pickkoStatus      || null,
      data.pickkoOrderId     || null,
      data.errorReason       || null,
      data.retries           || 0,
      data.detectedAt        || null,
      data.pickkoStartTime   || null,
      data.pickkoCompleteTime|| null,
    ]);
  } catch (e) {
    console.error('[db] addReservation 실패 (id:', id, '):', e.message);
    throw e;
  }
}

/**
 * 예약 상태 업데이트 (부분 업데이트)
 */
async function updateReservation(id, updates) {
  const fieldMap = {
    status:             'status',
    pickkoStatus:       'pickko_status',
    pickkoOrderId:      'pickko_order_id',
    errorReason:        'error_reason',
    retries:            'retries',
    pickkoStartTime:    'pickko_start_time',
    pickkoCompleteTime: 'pickko_complete_time',
  };

  const sets = [];
  const params = [];
  let i = 1;

  for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
    if (jsKey in updates) {
      sets.push(`${dbCol} = $${i++}`);
      params.push(updates[jsKey]);
    }
  }

  if (sets.length === 0) return;
  sets.push(`updated_at = to_char(now(),'YYYY-MM-DD HH24:MI:SS')`);
  params.push(id);

  try {
    await pgPool.run(SCHEMA, `UPDATE reservations SET ${sets.join(', ')} WHERE id = $${i}`, params);
  } catch (e) {
    console.error('[db] updateReservation 실패 (id:', id, '):', e.message);
    throw e;
  }
}

/**
 * 예약 정보 조회 (name, phoneRaw 자동 복호화)
 */
async function getReservation(id) {
  const row = await pgPool.get(SCHEMA, 'SELECT * FROM reservations WHERE id = $1', [id]);
  return row ? _decryptRow(row) : null;
}

/**
 * pending/processing/failed 상태 예약 목록 반환
 */
async function getPendingReservations() {
  try {
    const rows = await pgPool.query(SCHEMA,
      "SELECT * FROM reservations WHERE status IN ('pending','processing','failed') AND seen_only=0");
    return rows.map(_decryptRow);
  } catch (e) {
    console.error('[db] getPendingReservations 실패:', e.message);
    throw e;
  }
}

/**
 * completed 상태이지만 pickkoStatus가 verified/manual/time_elapsed가 아닌 항목
 */
async function getUnverifiedCompletedReservations() {
  const rows = await pgPool.query(SCHEMA,
    "SELECT * FROM reservations WHERE status='completed' AND seen_only=0 AND (pickko_status IS NULL OR pickko_status NOT IN ('verified','manual','time_elapsed'))");
  return rows.map(_decryptRow);
}

/**
 * 모든 네이버 키 Set 반환 → Set<"phoneRaw|date|startTime">
 */
async function getAllNaverKeys() {
  const rows = await pgPool.query(SCHEMA,
    'SELECT phone_raw_enc, date, start_time FROM reservations WHERE seen_only=0 AND date != $1', ['']);
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
 * processing 상태 항목 → failed 롤백
 */
async function rollbackProcessing() {
  const result = await pgPool.run(SCHEMA, `
    UPDATE reservations
    SET status='failed', error_reason='프로세스 강제 종료 (rollback)',
        updated_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
    WHERE status='processing'
  `);
  return result.rowCount;
}

/**
 * cutoffDate 이전 예약 삭제
 */
async function pruneOldReservations(cutoffDate) {
  const result = await pgPool.run(SCHEMA,
    "DELETE FROM reservations WHERE date != '' AND date < $1", [cutoffDate]);
  return result.rowCount;
}

// ─── cancelled_keys ────────────────────────────────────────────────

async function isCancelledKey(cancelKey) {
  const row = await pgPool.get(SCHEMA, 'SELECT 1 FROM cancelled_keys WHERE cancel_key = $1', [cancelKey]);
  return !!row;
}

async function addCancelledKey(cancelKey) {
  await pgPool.run(SCHEMA,
    "INSERT INTO cancelled_keys(cancel_key, cancelled_at) VALUES($1, to_char(now(),'YYYY-MM-DD HH24:MI:SS')) ON CONFLICT DO NOTHING",
    [cancelKey]);
}

async function pruneOldCancelledKeys(cutoffDate) {
  const result = await pgPool.run(SCHEMA,
    'DELETE FROM cancelled_keys WHERE cancelled_at < $1', [cutoffDate]);
  return result.rowCount;
}

// ─── kiosk_blocks ──────────────────────────────────────────────────

async function getKioskBlock(phoneRaw, date, start) {
  const id = hashKioskKey(phoneRaw, date, start);
  const row = await pgPool.get(SCHEMA, 'SELECT * FROM kiosk_blocks WHERE id = $1', [id]);
  if (!row) return null;
  return {
    ...row,
    phoneRaw:         decrypt(row.phone_raw_enc),
    name:             decrypt(row.name_enc),
    naverBlocked:     row.naver_blocked === 1,
    firstSeenAt:      row.first_seen_at,
    blockedAt:        row.blocked_at,
    naverUnblockedAt: row.naver_unblocked_at,
    start:            row.start_time,
    end:              row.end_time,
  };
}

async function upsertKioskBlock(phoneRaw, date, start, data) {
  const id = hashKioskKey(phoneRaw, date, start);
  await pgPool.run(SCHEMA, `
    INSERT INTO kiosk_blocks
      (id, phone_raw_enc, name_enc, date, start_time, end_time, room,
       amount, naver_blocked, first_seen_at, blocked_at, naver_unblocked_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT(id) DO UPDATE SET
      name_enc           = EXCLUDED.name_enc,
      end_time           = EXCLUDED.end_time,
      room               = EXCLUDED.room,
      amount             = EXCLUDED.amount,
      naver_blocked      = EXCLUDED.naver_blocked,
      first_seen_at      = COALESCE(kiosk_blocks.first_seen_at, EXCLUDED.first_seen_at),
      blocked_at         = EXCLUDED.blocked_at,
      naver_unblocked_at = EXCLUDED.naver_unblocked_at
  `, [
    id,
    encrypt(phoneRaw),
    encrypt(data.name || null),
    data.date    || date,
    data.start   || start,
    data.end     || null,
    data.room    || null,
    data.amount  || 0,
    data.naverBlocked    ? 1 : 0,
    data.firstSeenAt     || null,
    data.blockedAt       || null,
    data.naverUnblockedAt|| null,
  ]);
}

async function getBlockedKioskBlocks() {
  const rows = await pgPool.query(SCHEMA,
    'SELECT * FROM kiosk_blocks WHERE naver_blocked=1 AND naver_unblocked_at IS NULL');
  return rows.map(row => ({
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

async function getKioskBlocksForDate(date) {
  const rows = await pgPool.query(SCHEMA,
    'SELECT * FROM kiosk_blocks WHERE date = $1 AND naver_blocked = 1 AND naver_unblocked_at IS NULL',
    [date]);
  return rows.map(row => ({
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

async function pruneOldKioskBlocks(beforeDate) {
  const result = await pgPool.run(SCHEMA,
    'DELETE FROM kiosk_blocks WHERE date < $1', [beforeDate]);
  return result.rowCount;
}

// ─── alerts ────────────────────────────────────────────────────────

/**
 * 알림 추가 → 생성된 row id 반환
 */
async function addAlert(data) {
  const rows = await pgPool.query(SCHEMA, `
    INSERT INTO alerts
      (timestamp, type, title, message, sent, sent_at, resolved, resolved_at, phone, date, start_time)
    VALUES ($1,$2,$3,$4,0,NULL,$5,$6,$7,$8,$9)
    RETURNING id
  `, [
    data.timestamp  || new Date().toISOString(),
    data.type       || 'info',
    data.title      || null,
    data.message,
    data.resolved   || 0,
    data.resolvedAt || null,
    data.phone      || null,
    data.date       || null,
    data.startTime  || null,
  ]);
  return rows[0].id;
}

async function updateAlertSent(alertId, sentAt) {
  await pgPool.run(SCHEMA,
    'UPDATE alerts SET sent=1, sent_at=$1 WHERE id=$2',
    [sentAt || new Date().toISOString(), alertId]);
}

async function resolveAlert(phone, date, start) {
  const result = await pgPool.run(SCHEMA, `
    UPDATE alerts
    SET resolved=1, resolved_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
    WHERE resolved=0 AND type='error' AND phone=$1 AND date=$2 AND start_time=$3
  `, [phone, date, start]);
  return result.rowCount;
}

async function getUnresolvedAlerts() {
  return pgPool.query(SCHEMA,
    "SELECT * FROM alerts WHERE resolved=0 AND type='error' ORDER BY timestamp ASC");
}

async function pruneOldAlerts() {
  const cutoff48h = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const cutoff7d  = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const r1 = await pgPool.run(SCHEMA, 'DELETE FROM alerts WHERE resolved=1 AND timestamp < $1', [cutoff48h]);
  const r2 = await pgPool.run(SCHEMA, 'DELETE FROM alerts WHERE resolved=0 AND timestamp < $1', [cutoff7d]);
  return r1.rowCount + r2.rowCount;
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
  try { return decrypt(val); } catch { return null; }
}

// ─── daily_summary ─────────────────────────────────────────────────

async function upsertDailySummary(date, data) {
  const nowISO  = new Date().toISOString();
  const roomJson = JSON.stringify(data.roomAmounts || {});
  try {
  await pgPool.run(SCHEMA, `
    INSERT INTO daily_summary
      (date, total_amount, room_amounts_json, entries_count,
       pickko_total, pickko_study_room, general_revenue,
       reported_at, last_reported_at, confirmed, confirmed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,0,NULL)
    ON CONFLICT(date) DO UPDATE SET
      total_amount       = EXCLUDED.total_amount,
      room_amounts_json  = EXCLUDED.room_amounts_json,
      entries_count      = EXCLUDED.entries_count,
      pickko_total       = EXCLUDED.pickko_total,
      pickko_study_room  = EXCLUDED.pickko_study_room,
      general_revenue    = EXCLUDED.general_revenue,
      last_reported_at   = EXCLUDED.last_reported_at
  `, [
    date,
    data.totalAmount    || 0,
    roomJson,
    data.entriesCount   || 0,
    data.pickkoTotal    || 0,
    data.pickkoStudyRoom|| 0,
    data.generalRevenue || 0,
    nowISO,
  ]);
  } catch (e) {
    console.error('[db] upsertDailySummary 실패 (date:', date, '):', e.message);
    throw e;
  }
}

async function getDailySummary(date) {
  try {
    const row = await pgPool.get(SCHEMA, 'SELECT * FROM daily_summary WHERE date = $1', [date]);
    if (!row) return null;
    return {
      ...row,
      roomAmounts:     JSON.parse(row.room_amounts_json || '{}'),
      pickkoTotal:     row.pickko_total     || 0,
      pickkoStudyRoom: row.pickko_study_room|| 0,
      generalRevenue:  row.general_revenue  || 0,
      confirmed:       row.confirmed === 1,
    };
  } catch (e) {
    console.error('[db] getDailySummary 실패 (date:', date, '):', e.message);
    throw e;
  }
}

async function getUnconfirmedSummaryBefore(cutoffDate) {
  const row = await pgPool.get(SCHEMA,
    "SELECT * FROM daily_summary WHERE date < $1 AND confirmed = 0 ORDER BY date DESC LIMIT 1",
    [cutoffDate]);
  if (!row) return null;
  return {
    ...row,
    roomAmounts:     JSON.parse(row.room_amounts_json || '{}'),
    pickkoTotal:     row.pickko_total     || 0,
    pickkoStudyRoom: row.pickko_study_room|| 0,
    generalRevenue:  row.general_revenue  || 0,
    confirmed:       false,
  };
}

async function getLatestUnconfirmedSummary() {
  const row = await pgPool.get(SCHEMA,
    "SELECT * FROM daily_summary WHERE confirmed = 0 ORDER BY date DESC LIMIT 1");
  if (!row) return null;
  return {
    ...row,
    roomAmounts:     JSON.parse(row.room_amounts_json || '{}'),
    pickkoTotal:     row.pickko_total     || 0,
    pickkoStudyRoom: row.pickko_study_room|| 0,
    generalRevenue:  row.general_revenue  || 0,
    confirmed:       false,
  };
}

/**
 * 컨펌 처리 — daily_summary.confirmed=1 + room_revenue 누적 (트랜잭션)
 */
async function confirmDailySummary(date) {
  try {
  const row = await pgPool.get(SCHEMA, 'SELECT * FROM daily_summary WHERE date = $1', [date]);
  if (!row) return null;

  const nowISO = new Date().toISOString();
  const roomAmounts = JSON.parse(row.room_amounts_json || '{}');

  await pgPool.transaction(SCHEMA, async (client) => {
    await client.query(
      "UPDATE daily_summary SET confirmed=1, confirmed_at=$1 WHERE date=$2",
      [nowISO, date]
    );
    for (const [room, amount] of Object.entries(roomAmounts)) {
      await client.query(`
        INSERT INTO room_revenue (room, date, amount, confirmed_at)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT(room, date) DO UPDATE SET
          amount       = EXCLUDED.amount,
          confirmed_at = EXCLUDED.confirmed_at
      `, [room, date, amount, nowISO]);
    }
    if (row.general_revenue > 0) {
      await client.query(`
        INSERT INTO room_revenue (room, date, amount, confirmed_at)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT(room, date) DO UPDATE SET
          amount       = EXCLUDED.amount,
          confirmed_at = EXCLUDED.confirmed_at
      `, ['일반이용', date, row.general_revenue, nowISO]);
    }
  });

  return { date, totalAmount: row.total_amount, roomAmounts, generalRevenue: row.general_revenue || 0 };
  } catch (e) {
    console.error('[db] confirmDailySummary 실패 (date:', date, '):', e.message);
    throw e;
  }
}

async function getDailySummariesInRange(startDate, endDate) {
  const rows = await pgPool.query(SCHEMA,
    "SELECT * FROM daily_summary WHERE date >= $1 AND date <= $2 ORDER BY date",
    [startDate, endDate]);
  return rows.map(row => ({
    ...row,
    roomAmounts:     JSON.parse(row.room_amounts_json || '{}'),
    pickkoTotal:     row.pickko_total     || 0,
    pickkoStudyRoom: row.pickko_study_room|| 0,
    generalRevenue:  row.general_revenue  || 0,
    confirmed:       row.confirmed === 1,
  }));
}

// ─── room_revenue ───────────────────────────────────────────────────

async function getRoomRevenueSummary() {
  return pgPool.query(SCHEMA,
    "SELECT room, SUM(amount) as total_amount, COUNT(*) as days FROM room_revenue GROUP BY room ORDER BY room");
}

// ─── stats ──────────────────────────────────────────────────────────

async function getTodayStats(date) {
  try {
    const [naverTotalRow, naverConfirmedRow, kioskTotalRow] = await Promise.all([
      pgPool.get(SCHEMA,
        "SELECT COUNT(*) as cnt FROM reservations WHERE date=$1 AND seen_only=0 AND status NOT IN ('failed')", [date]),
      pgPool.get(SCHEMA,
        "SELECT COUNT(*) as cnt FROM reservations WHERE date=$1 AND seen_only=0 AND status='completed'", [date]),
      pgPool.get(SCHEMA,
        'SELECT COUNT(*) as cnt FROM kiosk_blocks WHERE date=$1', [date]),
    ]);
    const naverTotal     = Number(naverTotalRow?.cnt     ?? 0);
    const naverConfirmed = Number(naverConfirmedRow?.cnt ?? 0);
    const kioskTotal     = Number(kioskTotalRow?.cnt     ?? 0);
    return { naverTotal, naverConfirmed, kioskTotal, total: naverTotal + kioskTotal };
  } catch (e) {
    console.error('[db] getTodayStats 실패 (date:', date, '):', e.message);
    throw e;
  }
}

// ─── naver_future_confirmed ─────────────────────────────────────────

async function upsertFutureConfirmed(bookingKey, phoneRaw, date, startTime, endTime, room, scanCycle) {
  await pgPool.run(SCHEMA, `
    INSERT INTO naver_future_confirmed
      (booking_key, phone_raw, date, start_time, end_time, room, last_scan)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT(booking_key) DO UPDATE SET
      phone_raw  = EXCLUDED.phone_raw,
      date       = EXCLUDED.date,
      start_time = EXCLUDED.start_time,
      end_time   = EXCLUDED.end_time,
      room       = EXCLUDED.room,
      last_scan  = EXCLUDED.last_scan
  `, [bookingKey, phoneRaw || '', date || '', startTime || '', endTime || '', room || null, scanCycle || 0]);
}

async function getStaleConfirmed(currentCycle, minDate) {
  return pgPool.query(SCHEMA,
    'SELECT * FROM naver_future_confirmed WHERE last_scan < $1 AND date >= $2',
    [currentCycle, minDate || '']);
}

async function deleteStaleConfirmed(currentCycle, minDate) {
  const result = await pgPool.run(SCHEMA,
    'DELETE FROM naver_future_confirmed WHERE last_scan < $1 AND date >= $2',
    [currentCycle, minDate || '']);
  return result.rowCount;
}

async function pruneOldFutureConfirmed(cutoffDate) {
  const result = await pgPool.run(SCHEMA,
    'DELETE FROM naver_future_confirmed WHERE date < $1', [cutoffDate]);
  return result.rowCount;
}

// ─── 마이그레이션 헬퍼 ─────────────────────────────────────────────

/** schema_migrations 초기화 (PG에서는 테이블이 이미 존재) */
function initMigrationsTable() {
  return { schema: SCHEMA };
}

async function getAppliedMigrations() {
  const rows = await pgPool.query(SCHEMA, 'SELECT version FROM schema_migrations ORDER BY version ASC');
  return new Set(rows.map(r => r.version));
}

async function recordMigration(version, name) {
  await pgPool.run(SCHEMA,
    'INSERT INTO schema_migrations (version, name) VALUES ($1,$2) ON CONFLICT DO NOTHING',
    [version, name]);
}

async function removeMigration(version) {
  await pgPool.run(SCHEMA, 'DELETE FROM schema_migrations WHERE version = $1', [version]);
}

async function getFuturePickkoRegistered(fromDate) {
  const rows = await pgPool.query(SCHEMA,
    "SELECT * FROM reservations WHERE date >= $1 AND status='completed' AND seen_only=0 AND (pickko_status IS NULL OR pickko_status NOT IN ('cancelled','manual','time_elapsed'))",
    [fromDate]);
  return rows.map(_decryptRow);
}

async function getSchemaVersion() {
  const row = await pgPool.get(SCHEMA, 'SELECT MAX(version) as v FROM schema_migrations');
  return row?.v ?? 0;
}

module.exports = {
  // 마이그레이션
  initMigrationsTable, getAppliedMigrations, recordMigration, removeMigration, getSchemaVersion,
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
  // naver_future_confirmed
  upsertFutureConfirmed,
  getStaleConfirmed,
  deleteStaleConfirmed,
  pruneOldFutureConfirmed,
};
