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

const { encrypt, decrypt, hashKioskKey, hashKioskKeyLegacy } = require('./crypto');
const pgPool = require('../../../packages/core/lib/pg-pool');
const { createSchemaDbHelpers } = require('../../../packages/core/lib/db/helpers');

const SCHEMA = 'reservation';
const schemaDb = createSchemaDbHelpers(pgPool, SCHEMA);

function query(sql, params = []) {
  return schemaDb.query(sql, params);
}

function run(sql, params = []) {
  return schemaDb.run(sql, params);
}

function get(sql, params = []) {
  return schemaDb.get(sql, params);
}

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

async function findReservationByBooking(phone, date, start) {
  const normalizedPhone = String(phone || '').replace(/\D+/g, '');
  const row = await pgPool.get(
    SCHEMA,
    `
      SELECT *
      FROM reservations
      WHERE regexp_replace(phone, '\\D', '', 'g') = $1
        AND date = $2
        AND start_time = $3
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1
    `,
    [normalizedPhone, date, start],
  );
  return row ? _decryptRow(row) : null;
}

async function findReservationByCompositeKey(compositeKey) {
  const row = await pgPool.get(
    SCHEMA,
    'SELECT * FROM reservations WHERE composite_key = $1 ORDER BY updated_at DESC NULLS LAST LIMIT 1',
    [compositeKey],
  );
  return row ? _decryptRow(row) : null;
}

async function findReservationBySlot(phone, date, start, room = null) {
  const normalizedPhone = String(phone || '').replace(/\D+/g, '');
  const row = await pgPool.get(
    SCHEMA,
    `
      SELECT *
      FROM reservations
      WHERE regexp_replace(phone, '\\D', '', 'g') = $1
        AND date = $2
        AND start_time = $3
        AND ($4::text IS NULL OR room = $4)
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1
    `,
    [normalizedPhone, date, start, room || null],
  );
  return row ? _decryptRow(row) : null;
}

async function getReservationsBySlot(phone, date, start, room = null) {
  const normalizedPhone = String(phone || '').replace(/\D+/g, '');
  const rows = await pgPool.query(
    SCHEMA,
    `
      SELECT *
      FROM reservations
      WHERE regexp_replace(phone, '\\D', '', 'g') = $1
        AND date = $2
        AND start_time = $3
        AND ($4::text IS NULL OR room = $4)
      ORDER BY updated_at DESC NULLS LAST, id DESC
    `,
    [normalizedPhone, date, start, room || null],
  );
  return rows.map(_decryptRow);
}

async function hideDuplicateReservationsForSlot(canonicalId, phone, date, start, room = null) {
  const normalizedPhone = String(phone || '').replace(/\D+/g, '');
  const result = await pgPool.run(
    SCHEMA,
    `
      UPDATE reservations
      SET seen_only = 1,
          marked_seen = 1,
          updated_at = to_char(now(),'YYYY-MM-DD HH24:MI:SS')
      WHERE id <> $1
        AND regexp_replace(phone, '\\D', '', 'g') = $2
        AND date = $3
        AND start_time = $4
        AND ($5::text IS NULL OR room = $5)
        AND seen_only = 0
    `,
    [String(canonicalId), normalizedPhone, date, start, room || null],
  );
  return result.rowCount;
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
 * completed 상태이지만 pickkoStatus가 verified/manual/manual_pending/time_elapsed가 아닌 항목
 */
async function getUnverifiedCompletedReservations() {
  const rows = await pgPool.query(SCHEMA,
    "SELECT * FROM reservations WHERE status='completed' AND seen_only=0 AND (pickko_status IS NULL OR pickko_status NOT IN ('verified','manual','manual_retry','manual_pending','time_elapsed'))");
  return rows.map(_decryptRow);
}

/**
 * completed + manual_pending 상태의 미래 예약 반환
 */
async function getManualPendingReservations(fromDate) {
  const rows = await pgPool.query(
    SCHEMA,
    `
      SELECT *
      FROM reservations
      WHERE status = 'completed'
        AND seen_only = 0
        AND pickko_status = 'manual_pending'
        AND nullif(date, '') IS NOT NULL
        AND date >= $1
      ORDER BY date ASC, start_time ASC, updated_at ASC
    `,
    [fromDate],
  );
  return rows.map(_decryptRow);
}

async function getVerifiedReservationsForPayScan(fromDate, toDate) {
  const rows = await pgPool.query(
    SCHEMA,
    `
      SELECT *
      FROM reservations
      WHERE status = 'completed'
        AND pickko_status = 'verified'
        AND nullif(date, '') IS NOT NULL
        AND date >= $1
        AND date <= $2
        AND (
          error_reason IS NULL
          OR error_reason = ''
          OR error_reason NOT LIKE 'pay_scan_failed:%'
        )
      ORDER BY date ASC, start_time ASC, updated_at ASC
    `,
    [fromDate, toDate],
  );
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

function _mapKioskBlockRow(row) {
  if (!row) return null;
  return {
    ...row,
    phoneRaw:         decrypt(row.phone_raw_enc),
    name:             decrypt(row.name_enc),
    naverBlocked:     row.naver_blocked === 1,
    firstSeenAt:      row.first_seen_at,
    blockedAt:        row.blocked_at,
    naverUnblockedAt: row.naver_unblocked_at,
    lastBlockAttemptAt: row.last_block_attempt_at,
    lastBlockResult:  row.last_block_result,
    lastBlockReason:  row.last_block_reason,
    blockRetryCount:  Number(row.block_retry_count || 0),
    start:            row.start_time,
    end:              row.end_time,
  };
}

function _buildKioskLookupIds(phoneRaw, date, start, end, room) {
  const ids = [];
  if (end || room) ids.push(hashKioskKey(phoneRaw, date, start, end, room));
  ids.push(hashKioskKeyLegacy(phoneRaw, date, start));
  return [...new Set(ids)];
}

async function _findKioskBlockRow(phoneRaw, date, start, end = null, room = null) {
  for (const id of _buildKioskLookupIds(phoneRaw, date, start, end, room)) {
    const row = await pgPool.get(SCHEMA, 'SELECT * FROM kiosk_blocks WHERE id = $1', [id]);
    if (row) return row;
  }

  const rows = await pgPool.query(SCHEMA,
    'SELECT * FROM kiosk_blocks WHERE date = $1 AND start_time = $2',
    [date, start]
  );
  const filtered = rows.filter((row) => {
    const samePhone = decrypt(row.phone_raw_enc) === phoneRaw;
    if (!samePhone) return false;
    if (end && row.end_time !== end) return false;
    if (room && row.room !== room) return false;
    return true;
  });
  if (filtered.length === 0) return null;
  filtered.sort((a, b) => {
    const aTs = new Date(a.blocked_at || a.last_block_attempt_at || a.first_seen_at || 0).getTime();
    const bTs = new Date(b.blocked_at || b.last_block_attempt_at || b.first_seen_at || 0).getTime();
    return bTs - aTs;
  });
  return filtered[0];
}

async function getKioskBlock(phoneRaw, date, start, end = null, room = null) {
  const row = await _findKioskBlockRow(phoneRaw, date, start, end, room);
  return _mapKioskBlockRow(row);
}

async function upsertKioskBlock(phoneRaw, date, start, data) {
  const effectiveDate = data.date || date;
  const effectiveStart = data.start || start;
  const effectiveEnd = data.end || null;
  const effectiveRoom = data.room || null;
  const existingRow = await _findKioskBlockRow(phoneRaw, effectiveDate, effectiveStart, effectiveEnd, effectiveRoom);
  const legacyId = existingRow?.id || null;
  const id = hashKioskKey(phoneRaw, effectiveDate, effectiveStart, effectiveEnd, effectiveRoom);
  await pgPool.run(SCHEMA, `
    INSERT INTO kiosk_blocks
      (id, phone_raw_enc, name_enc, date, start_time, end_time, room,
       amount, naver_blocked, first_seen_at, blocked_at, naver_unblocked_at,
       last_block_attempt_at, last_block_result, last_block_reason, block_retry_count)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    ON CONFLICT(id) DO UPDATE SET
      name_enc           = EXCLUDED.name_enc,
      end_time           = EXCLUDED.end_time,
      room               = EXCLUDED.room,
      amount             = EXCLUDED.amount,
      naver_blocked      = EXCLUDED.naver_blocked,
      first_seen_at      = COALESCE(kiosk_blocks.first_seen_at, EXCLUDED.first_seen_at),
      blocked_at         = EXCLUDED.blocked_at,
      naver_unblocked_at = EXCLUDED.naver_unblocked_at,
      last_block_attempt_at = COALESCE(EXCLUDED.last_block_attempt_at, kiosk_blocks.last_block_attempt_at),
      last_block_result  = COALESCE(EXCLUDED.last_block_result, kiosk_blocks.last_block_result),
      last_block_reason  = COALESCE(EXCLUDED.last_block_reason, kiosk_blocks.last_block_reason),
      block_retry_count  = COALESCE(EXCLUDED.block_retry_count, kiosk_blocks.block_retry_count, 0)
  `, [
    id,
    encrypt(phoneRaw),
    encrypt(data.name || null),
      effectiveDate,
      effectiveStart,
      effectiveEnd,
      effectiveRoom,
    data.amount  || 0,
    data.naverBlocked    ? 1 : 0,
    data.firstSeenAt     || null,
    data.blockedAt       || null,
    data.naverUnblockedAt|| null,
    data.lastBlockAttemptAt || null,
    data.lastBlockResult || null,
      data.lastBlockReason || null,
      Number(data.blockRetryCount || 0),
  ]);

  if (legacyId && legacyId !== id) {
    await pgPool.run(SCHEMA, 'DELETE FROM kiosk_blocks WHERE id = $1', [legacyId]);
  }
}

async function recordKioskBlockAttempt(phoneRaw, date, start, data = {}) {
  const existing = await getKioskBlock(phoneRaw, data.date || date, data.start || start, data.end || null, data.room || null);
  const nextRetryCount = Number(existing?.blockRetryCount || 0) + (data.incrementRetry ? 1 : 0);

  await upsertKioskBlock(phoneRaw, date, start, {
    ...(existing || {}),
    ...data,
    date: data.date || existing?.date || date,
    start: data.start || existing?.start || start,
    end: data.end !== undefined ? data.end : (existing?.end || null),
    room: data.room !== undefined ? data.room : (existing?.room || null),
    amount: data.amount !== undefined ? data.amount : (existing?.amount || 0),
    name: data.name !== undefined ? data.name : (existing?.name || null),
    naverBlocked: typeof data.naverBlocked === 'boolean' ? data.naverBlocked : Boolean(existing?.naverBlocked),
    firstSeenAt: existing?.firstSeenAt || data.firstSeenAt || null,
    blockedAt: data.blockedAt !== undefined ? data.blockedAt : (existing?.blockedAt || null),
    naverUnblockedAt: data.naverUnblockedAt !== undefined ? data.naverUnblockedAt : (existing?.naverUnblockedAt || null),
    lastBlockAttemptAt: data.lastBlockAttemptAt || new Date().toISOString(),
    lastBlockResult: data.lastBlockResult || null,
    lastBlockReason: data.lastBlockReason || null,
    blockRetryCount: nextRetryCount,
  });
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
    lastBlockAttemptAt: row.last_block_attempt_at,
    lastBlockResult: row.last_block_result,
    lastBlockReason: row.last_block_reason,
    blockRetryCount: Number(row.block_retry_count || 0),
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
    lastBlockAttemptAt: row.last_block_attempt_at,
    lastBlockResult: row.last_block_result,
    lastBlockReason: row.last_block_reason,
    blockRetryCount: Number(row.block_retry_count || 0),
    start:        row.start_time,
    end:          row.end_time,
  }));
}

async function getOpenManualBlockFollowups(fromDate) {
  const rows = await pgPool.query(SCHEMA, `
    SELECT
      r.id,
      r.name_enc,
      r.phone,
      r.phone_raw_enc,
      r.date,
      r.start_time,
      r.end_time,
      r.room,
      kb.id AS kiosk_block_id,
      kb.naver_blocked,
      kb.naver_unblocked_at,
      kb.last_block_attempt_at,
      kb.last_block_result,
      kb.last_block_reason,
      kb.block_retry_count,
      kb.first_seen_at
    FROM reservations r
    LEFT JOIN kiosk_blocks kb
      ON kb.date = r.date
     AND kb.start_time = r.start_time
     AND (kb.end_time IS NULL OR r.end_time IS NULL OR kb.end_time = r.end_time)
     AND (kb.room IS NULL OR r.room IS NULL OR kb.room = r.room)
     AND kb.phone_raw_enc = r.phone_raw_enc
    WHERE r.pickko_status IN ('manual', 'manual_retry')
      AND r.status = 'completed'
      AND r.date >= $1
      AND (
        kb.id IS NULL
        OR (kb.naver_blocked <> 1 AND kb.naver_unblocked_at IS NULL)
      )
    ORDER BY r.date ASC, r.start_time ASC
  `, [fromDate]);

  return rows.map((row) => ({
    id: row.id,
    name: _safeDec(row.name_enc),
    phone: row.phone,
    phoneRaw: _safeDec(row.phone_raw_enc),
    date: row.date,
    start: row.start_time,
    end: row.end_time,
    room: row.room,
    amount: 0,
    kioskBlockId: row.kiosk_block_id,
    naverBlocked: row.naver_blocked === 1,
    naverUnblockedAt: row.naver_unblocked_at,
    lastBlockAttemptAt: row.last_block_attempt_at,
    lastBlockResult: row.last_block_result,
    lastBlockReason: row.last_block_reason,
    blockRetryCount: Number(row.block_retry_count || 0),
    firstSeenAt: row.first_seen_at,
  })).filter((row) => row.phoneRaw);
}

async function markKioskBlockManuallyConfirmed(phone, date, start, options = {}) {
  if (!phone || !date || !start) return null;

  const room = options.room || null;
  const reservation = room
    ? await findReservationBySlot(phone, date, start, room).catch(() => null)
    : await findReservationByBooking(phone, date, start).catch(() => null);

  const phoneRaw = options.phoneRaw
    || reservation?.phoneRaw
    || String(phone || '').replace(/\D+/g, '');
  if (!phoneRaw) return null;

  const probeEnd = options.end !== undefined ? options.end : (reservation?.end || null);
  const probeRoom = room || reservation?.room || null;
  const existing = await getKioskBlock(phoneRaw, date, start, probeEnd, probeRoom);
  const effectiveEnd = options.end !== undefined
    ? options.end
    : (reservation?.end || existing?.end || null);
  const effectiveRoom = room || reservation?.room || existing?.room || null;
  const appliedAt = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace(' ', 'T') + '+09:00';
  const payload = {
    name: options.name || existing?.name || reservation?.name || null,
    date,
    start,
    end: effectiveEnd,
    room: effectiveRoom,
    amount: Number(options.amount ?? existing?.amount ?? 0),
    naverBlocked: true,
    firstSeenAt: existing?.firstSeenAt || appliedAt,
    blockedAt: existing?.blockedAt || appliedAt,
    naverUnblockedAt: null,
    lastBlockAttemptAt: appliedAt,
    lastBlockResult: 'manually_confirmed',
    lastBlockReason: options.reason || 'operator_confirmed_naver_blocked',
    blockRetryCount: Number(existing?.blockRetryCount || 0),
  };

  await upsertKioskBlock(phoneRaw, date, start, payload);
  await recordKioskBlockAttempt(phoneRaw, date, start, {
    ...payload,
    incrementRetry: false,
  });

  return {
    phone,
    phoneRaw,
    date,
    start,
    end: effectiveEnd,
    room: effectiveRoom,
  };
}

async function resolveOpenKioskBlockFollowups(args = {}) {
  const phone = args.phone || null;
  const date = args.date || null;
  const start = args.start || args.start_time || null;

  if (phone && date && start) {
    const row = await markKioskBlockManuallyConfirmed(phone, date, start, args);
    return row ? [row] : [];
  }

  const rows = await pgPool.query(SCHEMA, `
    SELECT
      kb.phone_raw_enc,
      kb.date,
      kb.start_time,
      kb.end_time,
      kb.room,
      r.phone,
      r.name_enc
    FROM kiosk_blocks kb
    LEFT JOIN reservations r
      ON r.date = kb.date
     AND r.start_time = kb.start_time
     AND (kb.end_time IS NULL OR r.end_time IS NULL OR kb.end_time = r.end_time)
     AND (kb.room IS NULL OR r.room IS NULL OR kb.room = r.room)
     AND kb.phone_raw_enc = r.phone_raw_enc
    WHERE kb.naver_blocked <> 1
      AND kb.naver_unblocked_at IS NULL
      AND kb.last_block_result IN ('retryable_failure', 'deferred', 'uncertain')
      AND NULLIF(kb.last_block_attempt_at, '')::timestamptz >= now() - interval '24 hours'
    ORDER BY kb.last_block_attempt_at DESC NULLS LAST
  `);

  const touched = [];
  for (const row of rows) {
    const phoneRaw = _safeDec(row.phone_raw_enc);
    const effectivePhone = row.phone || phoneRaw;
    if (!effectivePhone || !row.date || !row.start_time) continue;
    const touchedRow = await markKioskBlockManuallyConfirmed(effectivePhone, row.date, row.start_time, {
      phoneRaw,
      end: row.end_time,
      room: row.room,
      name: _safeDec(row.name_enc),
    });
    if (touchedRow) touched.push(touchedRow);
  }

  return touched;
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
  const normalizedPhone = String(phone || '').replace(/\D+/g, '');
  const result = await pgPool.run(SCHEMA, `
    UPDATE alerts
    SET resolved=1, resolved_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
    WHERE resolved=0
      AND type='error'
      AND regexp_replace(phone, '\\D', '', 'g') = $1
      AND date=$2
      AND start_time=$3
  `, [normalizedPhone, date, start]);
  return result.rowCount;
}

async function resolveAlertsByTitle(title) {
  const result = await pgPool.run(SCHEMA, `
    UPDATE alerts
    SET resolved=1, resolved_at=to_char(now(),'YYYY-MM-DD HH24:MI:SS')
    WHERE resolved=0 AND type='error' AND title=$1
  `, [title]);
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
       pickko_study_room, general_revenue,
       reported_at, last_reported_at, confirmed, confirmed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$7,0,NULL)
    ON CONFLICT(date) DO UPDATE SET
      total_amount       = EXCLUDED.total_amount,
      room_amounts_json  = EXCLUDED.room_amounts_json,
      entries_count      = EXCLUDED.entries_count,
      pickko_study_room  = COALESCE(EXCLUDED.pickko_study_room, daily_summary.pickko_study_room),
      general_revenue    = COALESCE(EXCLUDED.general_revenue, daily_summary.general_revenue),
      last_reported_at   = EXCLUDED.last_reported_at
  `, [
    date,
    data.totalAmount    || 0,
    roomJson,
    data.entriesCount   || 0,
    data.pickkoStudyRoom ?? null,
    data.generalRevenue ?? null,
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
    pickkoStudyRoom: row.pickko_study_room|| 0,
    generalRevenue:  row.general_revenue  || 0,
    confirmed:       row.confirmed === 1,
  }));
}

// ─── pickko_order_raw ──────────────────────────────────────────────

async function upsertPickkoOrderRaw(row) {
  await pgPool.run(SCHEMA, `
    INSERT INTO pickko_order_raw (
      entry_key, source_date, source_axis, order_kind, transaction_no, detail_href,
      description, raw_amount, payment_at, pay_type, pay_device, memo,
      ticket_type, product_hours, product_days, member_hint, validity_start, validity_end,
      room_label, room_type, use_date, use_start_time, use_end_time, member_name,
      policy_amount, amount_match, created_at, updated_at
    )
    VALUES (
      $1,$2,$3,$4,$5,$6,
      $7,$8,$9,$10,$11,$12,
      $13,$14,$15,$16,$17,$18,
      $19,$20,$21,$22,$23,$24,
      $25,$26,now(),now()
    )
    ON CONFLICT(entry_key) DO UPDATE SET
      source_date      = EXCLUDED.source_date,
      source_axis      = EXCLUDED.source_axis,
      order_kind       = EXCLUDED.order_kind,
      transaction_no   = EXCLUDED.transaction_no,
      detail_href      = EXCLUDED.detail_href,
      description      = EXCLUDED.description,
      raw_amount       = EXCLUDED.raw_amount,
      payment_at       = COALESCE(EXCLUDED.payment_at, pickko_order_raw.payment_at),
      pay_type         = COALESCE(EXCLUDED.pay_type, pickko_order_raw.pay_type),
      pay_device       = COALESCE(EXCLUDED.pay_device, pickko_order_raw.pay_device),
      memo             = CASE
                           WHEN EXCLUDED.memo IS NOT NULL THEN EXCLUDED.memo
                           WHEN pickko_order_raw.memo IN ('주문상태', '주문일시', '결제타입', '결제기기') THEN NULL
                           ELSE pickko_order_raw.memo
                         END,
      ticket_type      = COALESCE(EXCLUDED.ticket_type, pickko_order_raw.ticket_type),
      product_hours    = COALESCE(EXCLUDED.product_hours, pickko_order_raw.product_hours),
      product_days     = COALESCE(EXCLUDED.product_days, pickko_order_raw.product_days),
      member_hint      = COALESCE(EXCLUDED.member_hint, pickko_order_raw.member_hint),
      validity_start   = COALESCE(EXCLUDED.validity_start, pickko_order_raw.validity_start),
      validity_end     = COALESCE(EXCLUDED.validity_end, pickko_order_raw.validity_end),
      room_label       = COALESCE(EXCLUDED.room_label, pickko_order_raw.room_label),
      room_type        = COALESCE(EXCLUDED.room_type, pickko_order_raw.room_type),
      use_date         = COALESCE(EXCLUDED.use_date, pickko_order_raw.use_date),
      use_start_time   = COALESCE(EXCLUDED.use_start_time, pickko_order_raw.use_start_time),
      use_end_time     = COALESCE(EXCLUDED.use_end_time, pickko_order_raw.use_end_time),
      member_name      = COALESCE(EXCLUDED.member_name, pickko_order_raw.member_name),
      policy_amount    = COALESCE(EXCLUDED.policy_amount, pickko_order_raw.policy_amount),
      amount_match     = COALESCE(EXCLUDED.amount_match, pickko_order_raw.amount_match),
      updated_at       = now()
  `, [
    row.entryKey,
    row.sourceDate,
    row.sourceAxis,
    row.orderKind,
    row.transactionNo ?? null,
    row.detailHref ?? null,
    row.description || '',
    Number(row.rawAmount || 0),
    row.paymentAt || null,
    row.payType || null,
    row.payDevice || null,
    row.memo || null,
    row.ticketType || null,
    row.productHours ?? null,
    row.productDays ?? null,
    row.memberHint || null,
    row.validityStart || null,
    row.validityEnd || null,
    row.roomLabel || null,
    row.roomType || null,
    row.useDate || null,
    row.useStartTime || null,
    row.useEndTime || null,
    row.memberName || null,
    row.policyAmount ?? null,
    row.amountMatch ?? null,
  ]);
}

async function upsertPickkoOrderRawBatch(rows) {
  for (const row of rows || []) {
    await upsertPickkoOrderRaw(row);
  }
}

function _formatDateParts(value, withTime = false) {
  if (!value) return null;
  if (!(value instanceof Date)) return value;
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(withTime ? {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    } : {}),
  }).formatToParts(value);
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  if (!withTime) return date;
  return `${date} ${get('hour')}:${get('minute')}:${get('second')}`;
}

function _normalizePickkoOrderRawRow(row) {
  return {
    ...row,
    source_date: _formatDateParts(row.source_date, false),
    payment_at: _formatDateParts(row.payment_at, true),
    validity_start: _formatDateParts(row.validity_start, false),
    validity_end: _formatDateParts(row.validity_end, false),
    use_date: _formatDateParts(row.use_date, false),
    created_at: _formatDateParts(row.created_at, true),
    updated_at: _formatDateParts(row.updated_at, true),
  };
}

async function getPickkoOrderRawByDate(sourceDate, sourceAxis = null) {
  const rows = sourceAxis
    ? await pgPool.query(
      SCHEMA,
      `SELECT * FROM pickko_order_raw WHERE source_date = $1 AND source_axis = $2 ORDER BY order_kind, transaction_no NULLS LAST, entry_key`,
      [sourceDate, sourceAxis],
    )
    : await pgPool.query(
      SCHEMA,
      `SELECT * FROM pickko_order_raw WHERE source_date = $1 ORDER BY source_axis, order_kind, transaction_no NULLS LAST, entry_key`,
      [sourceDate],
    );
  return rows.map(_normalizePickkoOrderRawRow);
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
    "SELECT * FROM reservations WHERE date >= $1 AND status='completed' AND seen_only=0 AND (pickko_status IS NULL OR pickko_status NOT IN ('cancelled','manual','manual_retry','manual_pending','time_elapsed'))",
    [fromDate]);
  return rows.map(_decryptRow);
}

async function getSchemaVersion() {
  const row = await pgPool.get(SCHEMA, 'SELECT MAX(version) as v FROM schema_migrations');
  return row?.v ?? 0;
}

module.exports = {
  query,
  run,
  get,
  // 마이그레이션
  initMigrationsTable, getAppliedMigrations, recordMigration, removeMigration, getSchemaVersion,
  // reservations
  isSeenId,
  markSeen,
  addReservation,
  updateReservation,
  getReservation,
  findReservationByBooking,
  findReservationByCompositeKey,
  findReservationBySlot,
  getReservationsBySlot,
  hideDuplicateReservationsForSlot,
  getPendingReservations,
  getUnverifiedCompletedReservations,
  getManualPendingReservations,
  getVerifiedReservationsForPayScan,
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
  recordKioskBlockAttempt,
  getBlockedKioskBlocks,
  getKioskBlocksForDate,
  getOpenManualBlockFollowups,
  markKioskBlockManuallyConfirmed,
  resolveOpenKioskBlockFollowups,
  pruneOldKioskBlocks,
  // alerts
  addAlert,
  updateAlertSent,
  resolveAlert,
  resolveAlertsByTitle,
  getUnresolvedAlerts,
  pruneOldAlerts,
  // daily_summary
  upsertDailySummary,
  getDailySummary,
  getDailySummariesInRange,
  getUnconfirmedSummaryBefore,
  getLatestUnconfirmedSummary,
  confirmDailySummary,
  // pickko_order_raw
  upsertPickkoOrderRaw,
  upsertPickkoOrderRawBatch,
  getPickkoOrderRawByDate,
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
