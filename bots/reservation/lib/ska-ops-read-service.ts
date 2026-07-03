// @ts-nocheck
'use strict';

const kst = require('../../../packages/core/lib/kst');
const crypto = require('node:crypto');
const pgPool = require('../../../packages/core/lib/pg-pool');
const {
  evaluateCancelLegacyCleanupGate,
  readCancelShadowHistory,
  readLatestCancelShadowSummary,
} = require('./cancel-shadow-history');

function addDays(dateStr, days) {
  const base = new Date(`${dateStr}T00:00:00+09:00`);
  return new Date(base.getTime() + days * 24 * 60 * 60 * 1000)
    .toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
}

function clampLimit(value, fallback = 30) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(200, Math.floor(n)) : fallback;
}

function normalizeRoom(value) {
  const text = String(value || '').toUpperCase();
  if (text.includes('A1')) return 'A1';
  if (text.includes('A2')) return 'A2';
  if (text.includes('B')) return 'B';
  return text.trim();
}

function slotKey({ date, use_date, start_time, use_start_time, room, room_type, room_label }) {
  return [
    String(date || use_date || '').slice(0, 10),
    normalizeRoom(room || room_type || room_label || ''),
    String(start_time || use_start_time || '').slice(0, 5),
  ].join('|');
}

function compactReservation(row) {
  return {
    id: row.id,
    date: row.date,
    start: row.start_time,
    end: row.end_time,
    room: normalizeRoom(row.room),
    status: row.status,
    pickkoStatus: row.pickko_status || null,
    updatedAt: row.updated_at || null,
  };
}

function compactPickko(row) {
  return {
    entryRef: crypto
      .createHash('sha256')
      .update(String(row.entry_key || ''))
      .digest('hex')
      .slice(0, 12),
    date: String(row.use_date || '').slice(0, 10),
    start: row.use_start_time,
    end: row.use_end_time,
    room: normalizeRoom(row.room_type || row.room_label),
    orderKind: row.order_kind,
    amount: Number(row.raw_amount || 0),
    paymentAt: row.payment_at || null,
  };
}

function tableMissing(error) {
  return error?.code === '42P01' || /does not exist|undefined_table/i.test(String(error?.message || error));
}

async function buildCancelPipelineStatus(args = {}, deps = {}) {
  const queryReadonly = deps.queryReadonly || pgPool.queryReadonly;
  const latestShadow = deps.latestShadow || readLatestCancelShadowSummary();
  const history = deps.history || readCancelShadowHistory({ limit: Number(args.historyLimit || 10) || 10 });
  const cleanupGate = evaluateCancelLegacyCleanupGate({ history, days: Number(args.days || 3) || 3 });
  let retryQueue = {
    ok: true,
    skipped: false,
    byStatus: [],
    byReason: [],
  };
  let migration = null;
  try {
    const [migrationRows, statusRows, reasonRows] = await Promise.all([
      queryReadonly('reservation', 'SELECT version, name FROM schema_migrations WHERE version = 14'),
      queryReadonly('reservation', `
        SELECT status, COUNT(*)::int AS count
        FROM cancel_retry_queue
        GROUP BY status
        ORDER BY status
      `),
      queryReadonly('reservation', `
        SELECT reason, status, COUNT(*)::int AS count
        FROM cancel_retry_queue
        GROUP BY reason, status
        ORDER BY reason, status
      `),
    ]);
    migration = migrationRows[0] || null;
    retryQueue = { ok: true, skipped: false, byStatus: statusRows, byReason: reasonRows };
  } catch (error) {
    if (tableMissing(error)) {
      retryQueue = { ok: true, skipped: true, reason: 'cancel_retry_queue_missing', byStatus: [], byReason: [] };
    } else {
      retryQueue = {
        ok: false,
        skipped: true,
        reason: 'cancel_retry_queue_query_failed',
        error: String(error?.message || error).slice(0, 240),
        byStatus: [],
        byReason: [],
      };
    }
  }
  return {
    ok: retryQueue.ok !== false,
    checkedAt: kst.datetimeStr(),
    mode: 'read_only',
    migration,
    retryQueue,
    shadow: {
      latest: latestShadow,
      historyCount: history.length,
      cleanupGate,
    },
    env: {
      PICKKO_CANCEL_ENABLE: String(process.env.PICKKO_CANCEL_ENABLE || ''),
      SKA_UNIFIED_CANCEL_SCANNER: String(process.env.SKA_UNIFIED_CANCEL_SCANNER || ''),
      SKA_CANCEL_RETRY_ENABLED: String(process.env.SKA_CANCEL_RETRY_ENABLED || ''),
    },
  };
}

async function buildReservationSyncCheck(args = {}, deps = {}) {
  const queryReadonly = deps.queryReadonly || pgPool.queryReadonly;
  const from = String(args.from || args.date || kst.today()).slice(0, 10);
  const to = String(args.to || args.date || from).slice(0, 10);
  const limit = clampLimit(args.limit, 30);
  const [reservationRows, invalidReservationDateRows, pickkoRows] = await Promise.all([
    queryReadonly('reservation', `
      SELECT id, date, start_time, end_time, room, status, pickko_status, updated_at
      FROM reservations
      WHERE NULLIF(BTRIM(date::text), '') IS NOT NULL
        AND BTRIM(date::text) ~ '^\\d{4}-\\d{2}-\\d{2}$'
        AND BTRIM(date::text) BETWEEN $1 AND $2
        AND COALESCE(seen_only, 0) = 0
        AND status IN ('completed', 'cancelled')
      ORDER BY date, start_time, room, id
      LIMIT 500
    `, [from, to]),
    queryReadonly('reservation', `
      SELECT COUNT(*)::int AS count
      FROM reservations
      WHERE COALESCE(seen_only, 0) = 0
        AND (
          NULLIF(BTRIM(date::text), '') IS NULL
          OR BTRIM(date::text) !~ '^\\d{4}-\\d{2}-\\d{2}$'
        )
    `),
    queryReadonly('reservation', `
      SELECT entry_key, use_date, use_start_time, use_end_time, room_type, room_label,
             order_kind, raw_amount, payment_at
      FROM pickko_order_raw
      WHERE use_date BETWEEN $1::date AND $2::date
        AND use_date IS NOT NULL
      ORDER BY use_date, use_start_time, room_type, entry_key
      LIMIT 500
    `, [from, to]),
  ]);

  const pickkoBySlot = new Map();
  for (const row of pickkoRows) {
    const key = slotKey(row);
    if (!pickkoBySlot.has(key)) pickkoBySlot.set(key, []);
    pickkoBySlot.get(key).push(row);
  }
  const reservationBySlot = new Map();
  for (const row of reservationRows) {
    const key = slotKey(row);
    if (!reservationBySlot.has(key)) reservationBySlot.set(key, []);
    reservationBySlot.get(key).push(row);
  }

  const naverCompletedMissingPickko = reservationRows
    .filter((row) => row.status === 'completed' && !pickkoBySlot.has(slotKey(row)))
    .slice(0, limit)
    .map(compactReservation);
  const cancelledButPickkoEvidence = reservationRows
    .filter((row) => row.status === 'cancelled' && pickkoBySlot.has(slotKey(row)))
    .slice(0, limit)
    .map((row) => ({ reservation: compactReservation(row), pickkoEvidence: pickkoBySlot.get(slotKey(row)).slice(0, 3).map(compactPickko) }));
  const pickkoOnly = pickkoRows
    .filter((row) => !reservationBySlot.has(slotKey(row)))
    .slice(0, limit)
    .map(compactPickko);

  return {
    ok: true,
    checkedAt: kst.datetimeStr(),
    mode: 'read_only_advisory',
    from,
    to,
    counts: {
      reservations: reservationRows.length,
      pickkoRows: pickkoRows.length,
      naverCompletedMissingPickko: naverCompletedMissingPickko.length,
      cancelledButPickkoEvidence: cancelledButPickkoEvidence.length,
      pickkoOnly: pickkoOnly.length,
      invalidReservationDates: Number(invalidReservationDateRows[0]?.count || 0),
    },
    hygiene: {
      invalidReservationDates: Number(invalidReservationDateRows[0]?.count || 0),
      invalidReservationDatePolicy: 'excluded_from_sync_check',
    },
    naverCompletedMissingPickko,
    cancelledButPickkoEvidence,
    pickkoOnly,
  };
}

function buildSkaCancelOpsAdvisory({ type, payload = {} } = {}) {
  if (type === 'session_expired') {
    return {
      ok: true,
      type,
      alertLevel: 3,
      title: '🚨 스카 네이버 세션 점검 필요',
      message: '네이버 세션 만료 또는 자동 재로그인 실패가 감지됐습니다. headed 로그인 복구 절차를 확인하세요.',
      payload,
    };
  }
  if (type === 'cancel_retry_manual_required') {
    return {
      ok: true,
      type,
      alertLevel: 2,
      title: '⚠️ 스카 취소 재시도 수동 확인 필요',
      message: '취소 재시도 큐에서 영구 실패 또는 재시도 소진 항목이 감지됐습니다. cancel-pipeline-status를 확인하세요.',
      payload,
    };
  }
  return {
    ok: false,
    type: type || 'unknown',
    reason: 'unsupported_advisory_type',
  };
}

module.exports = {
  addDays,
  buildCancelPipelineStatus,
  buildReservationSyncCheck,
  buildSkaCancelOpsAdvisory,
  compactReservation,
  compactPickko,
  normalizeRoom,
  slotKey,
};
