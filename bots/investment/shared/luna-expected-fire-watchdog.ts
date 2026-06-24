// @ts-nocheck

import * as db from './db.ts';

export const LUNA_EXPECTED_FIRE_WATCHDOG_CONFIRM = 'luna-expected-fire-watchdog-shadow';

export const NORMAL_ENTRY_TRIGGER_BLOCK_REASONS = Object.freeze([
  'conditions_not_met',
  'active_entry_trigger_quality_terminal_blocked',
  'active_entry_trigger_quality_gate_blocked',
  'tradingview_chart_guard_blocked',
  'live_risk_gate_blocked',
  'live_risk_gate_terminal_blocked',
  // 유니버스 밖 차단(정상 차단으로 분류). 유니버스 크기는 LUNA_BINANCE_TOP_VOLUME_LIMIT env 제어.
  // 신규('top')+레거시('top30') 병기는 의도 - Set 정확매칭이라 둘 다 필요. 중복 버그 아님.
  'outside_binance_top_volume_universe',
  'outside_binance_top30_volume_universe',
  'duplicate_fire_cooldown',
  'open_position_reentry_guard',
  'recent_executed_trade_cooldown',
  'market_event_missing',
]);

function safeJson(value: any, fallback: any = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function normalizeLimit(value: any, fallback = 100) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : fallback;
}

function normalizeNumber(value: any, fallback: number) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function iso(value: any = Date.now()) {
  return new Date(value).toISOString();
}

function canWrite(options: any = {}) {
  return options.apply === true
    && options.dryRun !== true
    && String(options.confirm || '').trim() === LUNA_EXPECTED_FIRE_WATCHDOG_CONFIRM;
}

function exchangeVariants(exchange: any) {
  const raw = String(exchange || '').trim().toLowerCase();
  if (raw === 'kis_domestic') return ['kis', 'kis_domestic'];
  if (raw === 'kis') return ['kis', 'kis_domestic'];
  if (raw === 'kis_overseas') return ['kis_overseas'];
  return [raw || 'binance'];
}

function marketFromExchange(exchange: any) {
  const raw = String(exchange || '').trim().toLowerCase();
  if (raw === 'kis' || raw === 'kis_domestic') return 'domestic';
  if (raw === 'kis_overseas') return 'overseas';
  return 'crypto';
}

function isNormalBlockReason(reason: any, whitelist = NORMAL_ENTRY_TRIGGER_BLOCK_REASONS) {
  return new Set(whitelist.map((item) => String(item))).has(String(reason || '').trim());
}

function parseReadyAt(row: any = {}) {
  const meta = safeJson(row.trigger_meta);
  return meta.lastReadyAt || row.ready_at || row.last_ready_at || null;
}

export function normalizeExpectedFireTriggerRow(row: any = {}) {
  const meta = safeJson(row.trigger_meta);
  const readyAt = parseReadyAt(row);
  const expiredAt = row.expired_at ?? row.expires_at ?? null;
  return {
    triggerId: row.trigger_id || row.id,
    symbol: row.symbol,
    exchange: row.exchange,
    market: marketFromExchange(row.exchange),
    setupType: row.setup_type || row.setupType || null,
    readyAt: readyAt ? iso(readyAt) : null,
    expiredAt: expiredAt ? iso(expiredAt) : null,
    predictiveScore: row.predictive_score == null ? null : Number(row.predictive_score),
    confidence: row.confidence == null ? null : Number(row.confidence),
    reason: meta.reason || row.reason || null,
    triggerState: row.trigger_state || null,
    firedAt: row.fired_at || null,
    terminalBlock: String(meta.terminalBlock ?? '').toLowerCase() === 'true',
    triggerMeta: meta,
    shadowOnly: true,
  };
}

export async function loadExpectedFireCandidates(options: any = {}, deps: any = {}) {
  const queryFn = deps.queryFn || db.query;
  const limit = normalizeLimit(options.limit, 100);
  const lookbackHours = normalizeLimit(options.lookbackHours, 24);
  const cutoff = new Date(Date.parse(String(options.now || new Date())) - lookbackHours * 3_600_000).toISOString();
  const whitelist = options.normalBlockReasons || NORMAL_ENTRY_TRIGGER_BLOCK_REASONS;
  const rows = await queryFn(
    `SELECT id, symbol, exchange, setup_type, trigger_state, confidence, predictive_score,
            expires_at AS expired_at, fired_at, trigger_meta, trigger_context, updated_at
       FROM entry_triggers
      WHERE trigger_meta ? 'lastReadyAt'
        AND fired_at IS NULL
        AND LOWER(COALESCE(trigger_meta->>'terminalBlock', 'false')) <> 'true'
        AND NOT (COALESCE(trigger_meta->>'reason', '') = ANY($1::text[]))
        AND (trigger_meta->>'lastReadyAt')::timestamptz >= $2::timestamptz
      ORDER BY (trigger_meta->>'lastReadyAt')::timestamptz DESC
      LIMIT $3`,
    [whitelist, cutoff, limit],
  );
  return (rows || [])
    .map(normalizeExpectedFireTriggerRow)
    .filter((row) => (
      row.triggerId
      && row.symbol
      && row.exchange
      && row.readyAt
      && !row.firedAt
      && row.terminalBlock !== true
      && !isNormalBlockReason(row.reason, whitelist)
    ));
}

export async function detectExecutionMatch(candidate: any = {}, options: any = {}, deps: any = {}) {
  const queryFn = deps.queryFn || db.query;
  const readyAt = candidate.readyAt || parseReadyAt(candidate);
  if (!readyAt) return { matched: false, source: null };
  const matchWindowMinutes = normalizeLimit(options.matchWindowMinutes, 30);
  const expiredMs = candidate.expiredAt ? Date.parse(candidate.expiredAt) : NaN;
  const readyMs = Date.parse(String(readyAt));
  const endAt = Number.isFinite(expiredMs)
    ? new Date(expiredMs + matchWindowMinutes * 60_000).toISOString()
    : new Date(readyMs + matchWindowMinutes * 60_000).toISOString();
  const variants = exchangeVariants(candidate.exchange);
  const rows = await queryFn(
    `WITH params AS (
       SELECT $1::text AS symbol,
              $2::text[] AS exchanges,
              $3::timestamptz AS ready_at,
              $4::timestamptz AS end_at
     )
     SELECT
       EXISTS (
         SELECT 1
           FROM trades t, params p
          WHERE t.symbol = p.symbol
            AND LOWER(COALESCE(t.exchange, '')) = ANY(p.exchanges)
            AND LOWER(COALESCE(t.side, '')) IN ('buy', 'long')
            AND (t.executed_at AT TIME ZONE 'Asia/Seoul') >= p.ready_at
            AND (t.executed_at AT TIME ZONE 'Asia/Seoul') <= p.end_at
            AND COALESCE(t.execution_origin, '') NOT IN ('smoke', 'test', 'fixture')
       ) AS trade_match,
       EXISTS (
         SELECT 1
           FROM trade_journal j, params p
          WHERE j.symbol = p.symbol
            AND LOWER(COALESCE(j.exchange, '')) = ANY(p.exchanges)
            AND j.entry_time IS NOT NULL
            AND to_timestamp(j.entry_time / 1000.0) >= p.ready_at
            AND to_timestamp(j.entry_time / 1000.0) <= p.end_at
            AND COALESCE(j.execution_origin, '') NOT IN ('smoke', 'test', 'fixture')
       ) AS journal_match,
       EXISTS (
         SELECT 1
           FROM positions pos, params p
          WHERE pos.symbol = p.symbol
            AND LOWER(COALESCE(pos.exchange, '')) = ANY(p.exchanges)
            AND COALESCE(pos.amount, 0) <> 0
       ) AS position_match`,
    [candidate.symbol, variants, readyAt, endAt],
  );
  const row = rows?.[0] || {};
  if (row.trade_match) return { matched: true, source: 'trades' };
  if (row.journal_match) return { matched: true, source: 'trade_journal' };
  if (row.position_match) return { matched: true, source: 'positions' };
  return { matched: false, source: null };
}

export async function evaluateExpectedFireWatchdog(options: any = {}, deps: any = {}) {
  const candidates = await loadExpectedFireCandidates(options, deps);
  const rows = [];
  for (const candidate of candidates) {
    const match = await (deps.detectExecutionMatch || detectExecutionMatch)(candidate, options, deps).catch((error) => ({
      matched: false,
      source: null,
      error: error?.message || String(error),
    }));
    rows.push({
      ...candidate,
      matched: match.matched === true,
      matchedSource: match.source || null,
      matchError: match.error || null,
      detectedAt: iso(options.now || Date.now()),
      placed: false,
      liveMutation: false,
      shadowOnly: true,
    });
  }
  return rows;
}

export async function persistExpectedFireWatchdogRows(rows: any[] = [], deps: any = {}) {
  const runFn = deps.runFn || db.run;
  let written = 0;
  for (const row of rows || []) {
    const result = await runFn(
      `INSERT INTO luna_silent_miss_log
        (trigger_id, symbol, exchange, setup_type, ready_at, expired_at, predictive_score,
         confidence, reason, matched, detected_at, shadow_only)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,TRUE)
       ON CONFLICT (trigger_id) DO UPDATE SET
         symbol = EXCLUDED.symbol,
         exchange = EXCLUDED.exchange,
         setup_type = EXCLUDED.setup_type,
         ready_at = EXCLUDED.ready_at,
         expired_at = EXCLUDED.expired_at,
         predictive_score = EXCLUDED.predictive_score,
         confidence = EXCLUDED.confidence,
         reason = EXCLUDED.reason,
         matched = EXCLUDED.matched,
         detected_at = EXCLUDED.detected_at,
         shadow_only = TRUE`,
      [
        row.triggerId,
        row.symbol,
        row.exchange,
        row.setupType,
        row.readyAt,
        row.expiredAt,
        row.predictiveScore,
        row.confidence,
        row.reason,
        row.matched === true,
        row.detectedAt || iso(),
      ],
    );
    written += Number(result?.rowCount || 0);
  }
  return written;
}

export async function pruneExpectedFireWatchdogRows(options: any = {}, deps: any = {}) {
  const retentionDays = normalizeLimit(options.retentionDays, 30);
  const runFn = deps.runFn || db.run;
  const result = await runFn(
    `DELETE FROM luna_silent_miss_log
      WHERE detected_at < NOW() - ($1::int * INTERVAL '1 day')`,
    [retentionDays],
  );
  return Number(result?.rowCount || 0);
}

export async function countExpectedFireWatchdogPrunableRows(options: any = {}, deps: any = {}) {
  const retentionDays = normalizeLimit(options.retentionDays, 30);
  const queryFn = deps.queryFn || db.query;
  const rows = await queryFn(
    `SELECT COUNT(*)::int AS count
       FROM luna_silent_miss_log
      WHERE detected_at < NOW() - ($1::int * INTERVAL '1 day')`,
    [retentionDays],
  ).catch(() => [{ count: 0 }]);
  return Number(rows?.[0]?.count || 0);
}

export async function runExpectedFireWatchdog(options: any = {}, deps: any = {}) {
  const apply = options.apply === true;
  const dryRun = options.dryRun ?? !apply;
  const writable = canWrite({ ...options, dryRun });
  const errors = [];
  if (apply && !writable) {
    return {
      ok: false,
      blocked: true,
      reason: 'confirm_required',
      dryRun,
      apply,
      scanned: 0,
      candidates: 0,
      matched: 0,
      silentMisses: 0,
      written: 0,
      pruned: 0,
      placed: 0,
      liveMutation: false,
      shadowOnly: true,
      errors,
    };
  }
  let rows = [];
  try {
    rows = await evaluateExpectedFireWatchdog(options, deps);
  } catch (error) {
    errors.push({ step: 'evaluate', error: error?.message || String(error) });
  }
  const matched = rows.filter((row) => row.matched === true).length;
  const silentMisses = rows.filter((row) => row.matched !== true).length;
  let written = 0;
  let pruned = 0;
  if (writable) {
    try {
      written = await persistExpectedFireWatchdogRows(rows, deps);
      pruned = await pruneExpectedFireWatchdogRows(options, deps);
    } catch (error) {
      errors.push({ step: 'persist', error: error?.message || String(error) });
    }
  } else {
    pruned = await countExpectedFireWatchdogPrunableRows(options, deps);
  }
  return {
    ok: errors.length === 0,
    dryRun,
    apply,
    scanned: rows.length,
    candidates: rows.length,
    matched,
    silentMisses,
    written,
    pruned,
    rows,
    placed: 0,
    liveMutation: false,
    shadowOnly: true,
    errors,
  };
}

export const _testOnly = {
  canWrite,
  exchangeVariants,
  isNormalBlockReason,
  marketFromExchange,
  normalizeExpectedFireTriggerRow,
};

export default {
  LUNA_EXPECTED_FIRE_WATCHDOG_CONFIRM,
  NORMAL_ENTRY_TRIGGER_BLOCK_REASONS,
  loadExpectedFireCandidates,
  detectExecutionMatch,
  evaluateExpectedFireWatchdog,
  persistExpectedFireWatchdogRows,
  pruneExpectedFireWatchdogRows,
  countExpectedFireWatchdogPrunableRows,
  runExpectedFireWatchdog,
};
