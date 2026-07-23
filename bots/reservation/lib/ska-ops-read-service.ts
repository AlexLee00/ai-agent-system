// @ts-nocheck
'use strict';

const kst = require('../../../packages/core/lib/kst');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const pgPool = require('../../../packages/core/lib/pg-pool');
const {
  buildDeployDriftGuardReport,
} = require('../../_shared/hooks/deploy-drift-guard');
const {
  assessPickkoLiveSnapshot,
  loadPickkoLiveSnapshot,
} = require('./pickko-live-snapshot');

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

function opaqueRef(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .slice(0, 12);
}

function compactReservation(row) {
  return {
    reservationRef: opaqueRef(row.id),
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
    entryRef: opaqueRef(row.entry_key),
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
    env: {
      PICKKO_CANCEL_ENABLE: String(process.env.PICKKO_CANCEL_ENABLE || ''),
      SKA_CANCEL_RETRY_ENABLED: String(process.env.SKA_CANCEL_RETRY_ENABLED || ''),
    },
  };
}

async function buildReservationSyncCheck(args = {}, deps = {}) {
  const queryReadonly = deps.queryReadonly || pgPool.queryReadonly;
  const readPickkoSnapshot = deps.readPickkoSnapshot || loadPickkoLiveSnapshot;
  const from = String(args.from || args.date || kst.today()).slice(0, 10);
  const to = String(args.to || args.date || from).slice(0, 10);
  const limit = clampLimit(args.limit, 30);
  const [reservationRows, invalidReservationDateRows, snapshot] = await Promise.all([
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
    Promise.resolve(readPickkoSnapshot()),
  ]);

  const assessment = assessPickkoLiveSnapshot(snapshot, {
    from,
    to,
    nowMs: deps.nowMs,
    maxAgeMs: deps.maxSnapshotAgeMs,
  });
  const invalidReservationDates = Number(invalidReservationDateRows[0]?.count || 0);
  if (!assessment.usable) {
    return {
      ok: true,
      skipped: true,
      reason: assessment.reason,
      checkedAt: kst.datetimeStr(),
      mode: 'read_only_advisory',
      from,
      to,
      evidence: {
        source: 'pickko_live_snapshot',
        collectedAt: snapshot?.collectedAt || null,
        coverage: snapshot?.coverage || null,
        ageMs: assessment.ageMs ?? null,
      },
      counts: {
        reservations: reservationRows.length,
        comparableReservations: 0,
        pickkoRows: 0,
        naverCompletedMissingPickko: 0,
        cancelledButPickkoEvidence: 0,
        pickkoOnly: 0,
        pendingSnapshotRefresh: reservationRows.length,
        invalidReservationDates,
      },
      hygiene: {
        invalidReservationDates,
        invalidReservationDatePolicy: 'excluded_from_sync_check',
      },
      naverCompletedMissingPickko: [],
      cancelledButPickkoEvidence: [],
      pickkoOnly: [],
      pendingSnapshotRefresh: reservationRows.slice(0, limit).map(compactReservation),
    };
  }

  const pickkoRows = snapshot.entries
    .filter((entry) => entry.date >= from && entry.date <= to)
    .map((entry) => ({
      entry_key: `${entry.date}|${entry.room}|${entry.start}|${entry.end || ''}`,
      use_date: entry.date,
      use_start_time: entry.start,
      use_end_time: entry.end,
      room_type: entry.room,
      room_label: entry.room,
      order_kind: 'paid_snapshot',
      raw_amount: 0,
      payment_at: null,
  }));
  const comparableReservationRows = reservationRows.filter((row) => {
    const updatedAtMs = Date.parse(row.updated_at);
    return Number.isFinite(updatedAtMs) && updatedAtMs <= assessment.collectedAtMs;
  });
  const pendingSnapshotRefreshRows = reservationRows
    .filter((row) => !comparableReservationRows.includes(row));
  const pendingSnapshotRefresh = pendingSnapshotRefreshRows
    .slice(0, limit)
    .map(compactReservation);

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

  const naverCompletedMissingPickko = comparableReservationRows
    .filter((row) => row.status === 'completed' && !pickkoBySlot.has(slotKey(row)))
    .slice(0, limit)
    .map(compactReservation);
  const cancelledButPickkoEvidence = comparableReservationRows
    .filter((row) => row.status === 'cancelled' && pickkoBySlot.has(slotKey(row)))
    .slice(0, limit)
    .map((row) => ({ reservation: compactReservation(row), pickkoEvidence: pickkoBySlot.get(slotKey(row)).slice(0, 3).map(compactPickko) }));
  const pickkoOnly = pickkoRows
    .filter((row) => !reservationBySlot.has(slotKey(row)))
    .slice(0, limit)
    .map(compactPickko);

  return {
    ok: true,
    skipped: false,
    status: pendingSnapshotRefreshRows.length > 0 ? 'partial' : 'complete',
    checkedAt: kst.datetimeStr(),
    mode: 'read_only_advisory',
    from,
    to,
    evidence: {
      source: 'pickko_live_snapshot',
      collectedAt: snapshot.collectedAt,
      coverage: snapshot.coverage,
      ageMs: assessment.ageMs,
    },
    counts: {
      reservations: reservationRows.length,
      comparableReservations: comparableReservationRows.length,
      pickkoRows: pickkoRows.length,
      naverCompletedMissingPickko: naverCompletedMissingPickko.length,
      cancelledButPickkoEvidence: cancelledButPickkoEvidence.length,
      pickkoOnly: pickkoOnly.length,
      pendingSnapshotRefresh: pendingSnapshotRefreshRows.length,
      invalidReservationDates,
    },
    hygiene: {
      invalidReservationDates,
      invalidReservationDatePolicy: 'excluded_from_sync_check',
    },
    naverCompletedMissingPickko,
    cancelledButPickkoEvidence,
    pickkoOnly,
    pendingSnapshotRefresh,
  };
}

async function buildSkaRuntimeContractStatus(args = {}, deps = {}) {
  const queryReadonly = deps.queryReadonly || pgPool.queryReadonly;
  const readPickkoSnapshot = deps.readPickkoSnapshot || loadPickkoLiveSnapshot;
  const nowMs = Number.isFinite(deps.nowMs) ? deps.nowMs : Date.now();
  const repoRoot = path.resolve(__dirname, '../../..');
  const envAllowlist = [
    'PICKKO_CANCEL_ENABLE',
    'PICKKO_CANCEL_MUTATION_ENABLE',
    'SKA_ENABLE_PICKKO_CANCEL_MUTATION',
    'SKA_CANCEL_RETRY_ENABLED',
  ];

  let monitorDrift;
  try {
    monitorDrift = deps.buildMonitorDrift
      ? await deps.buildMonitorDrift()
      : buildDeployDriftGuardReport({
        label: 'ai.ska.naver-monitor',
        expectedPath: path.join(repoRoot, 'bots/reservation/launchd/ai.ska.naver-monitor.plist'),
        loadedPath: path.join(os.homedir(), 'Library/LaunchAgents/ai.ska.naver-monitor.plist'),
        envAllowlist,
        includeLiveState: true,
      });
  } catch (error) {
    monitorDrift = {
      ok: true,
      skipped: true,
      reason: 'monitor_drift_check_unavailable',
      error: String(error?.message || error).slice(0, 240),
    };
  }

  let historicalRaw = {
    ok: true,
    skipped: false,
    role: 'historical_forecast_feature_input',
    scheduledCollector: false,
    latestUpdatedAt: null,
    latestSourceDate: null,
    rowCount: 0,
  };
  try {
    const rows = await queryReadonly('reservation', `
      SELECT
        MAX(updated_at)::text AS latest_updated_at,
        MAX(source_date)::text AS latest_source_date,
        COUNT(*)::int AS row_count
      FROM pickko_order_raw
    `);
    historicalRaw = {
      ...historicalRaw,
      latestUpdatedAt: rows[0]?.latest_updated_at || null,
      latestSourceDate: rows[0]?.latest_source_date || null,
      rowCount: Number(rows[0]?.row_count || 0),
    };
  } catch (error) {
    historicalRaw = {
      ...historicalRaw,
      ok: false,
      skipped: true,
      reason: tableMissing(error) ? 'pickko_order_raw_missing' : 'pickko_order_raw_query_failed',
    };
  }

  let dataHygiene = {
    ok: true,
    skipped: false,
    nullDates: 0,
    blankDates: 0,
    malformedDates: 0,
  };
  try {
    const rows = await queryReadonly('reservation', `
      SELECT
        COUNT(*) FILTER (WHERE date IS NULL)::int AS null_dates,
        COUNT(*) FILTER (WHERE date IS NOT NULL AND BTRIM(date::text) = '')::int AS blank_dates,
        COUNT(*) FILTER (
          WHERE NULLIF(BTRIM(date::text), '') IS NOT NULL
            AND BTRIM(date::text) !~ '^\\d{4}-\\d{2}-\\d{2}$'
        )::int AS malformed_dates
      FROM reservations
    `);
    dataHygiene = {
      ...dataHygiene,
      nullDates: Number(rows[0]?.null_dates || 0),
      blankDates: Number(rows[0]?.blank_dates || 0),
      malformedDates: Number(rows[0]?.malformed_dates || 0),
    };
  } catch (_error) {
    dataHygiene = {
      ...dataHygiene,
      ok: false,
      skipped: true,
      reason: 'reservation_date_hygiene_query_failed',
    };
  }

  const snapshot = readPickkoSnapshot();
  const coverageFrom = String(args.from || kst.today()).slice(0, 10);
  const coverageTo = String(args.to || addDays(coverageFrom, 1)).slice(0, 10);
  const assessment = assessPickkoLiveSnapshot(snapshot, {
    from: coverageFrom,
    to: coverageTo,
    nowMs,
    maxAgeMs: deps.maxSnapshotAgeMs,
  });

  return {
    ok: true,
    checkedAt: kst.datetimeStr(),
    mode: 'read_only_advisory',
    liveMutation: false,
    monitorDrift,
    liveSnapshot: {
      usable: assessment.usable,
      reason: assessment.reason,
      ageMs: assessment.ageMs ?? null,
      collectedAt: snapshot?.collectedAt || null,
      coverage: snapshot?.coverage || null,
      entryCount: Number(snapshot?.entryCount || snapshot?.entries?.length || 0),
    },
    historicalRaw,
    dataHygiene,
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
  buildSkaRuntimeContractStatus,
  buildSkaCancelOpsAdvisory,
  compactReservation,
  compactPickko,
  normalizeRoom,
  slotKey,
};
