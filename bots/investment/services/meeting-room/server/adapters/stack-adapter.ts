// @ts-nocheck

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as db from '../../../../shared/db.ts';
import { evaluateKisMarketHours } from '../../../../shared/kis-market-hours-guard.ts';
import { normalizeMeetingType } from '../../config/meeting.config.ts';

const INVESTMENT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const REGISTRY_PROPOSALS_PATH = path.join(INVESTMENT_ROOT, 'output', 'luna-registry-proposals.json');

function safeJson(value: any, fallback: any = {}) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function readJson(filePath: string, fallback: any = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function safeQuery(queryFn: any, sql: string, params: any[] = []) {
  try {
    return await queryFn(sql, params);
  } catch (error) {
    return [{ __error: error?.message || String(error) }];
  }
}

function kstDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(new Date(now));
  const obj = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { date: `${obj.year}-${obj.month}-${obj.day}`, weekday: obj.weekday };
}

function kstDateKey(now = new Date()) {
  return kstDateParts(now).date;
}

function isWeekendKst(now = new Date()) {
  return ['Sat', 'Sun'].includes(kstDateParts(now).weekday);
}

export function buildMarketSegments(now = new Date()) {
  const domestic = evaluateKisMarketHours({ market: 'domestic', now });
  const overseas = evaluateKisMarketHours({ market: 'overseas', now });
  const domesticWeekend = isWeekendKst(now);
  const usWeekend = ['Sat', 'Sun'].includes(String(overseas.marketDateStr ? new Date(`${overseas.marketDateStr}T12:00:00-05:00`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' }) : ''));
  return [
    {
      market: 'domestic',
      label: '국내 장전 계획',
      active: !domesticWeekend && domestic.reasonCode !== 'holiday',
      skipped: domesticWeekend || domestic.reasonCode === 'holiday',
      reason: domesticWeekend ? 'weekend' : domestic.reasonCode,
      marketHours: domestic,
    },
    {
      market: 'overseas',
      label: '미국 장후 평가',
      active: !usWeekend && overseas.reasonCode !== 'holiday',
      skipped: usWeekend || overseas.reasonCode === 'holiday',
      reason: usWeekend ? 'weekend' : overseas.reasonCode,
      marketHours: overseas,
    },
    {
      market: 'crypto',
      label: 'crypto 24h 점검',
      active: true,
      skipped: false,
      reason: 'crypto_24h',
      marketHours: { market: 'crypto', state: 'always_open', reasonCode: 'crypto_24h' },
    },
  ];
}

function latestByMarketRows(rows = [], marketKey = 'market') {
  const byMarket = new Map();
  for (const row of rows || []) {
    if (row.__error) continue;
    const market = row[marketKey];
    if (!market || byMarket.has(market)) continue;
    byMarket.set(market, row);
  }
  return Array.from(byMarket.values());
}

function cleanRows(rows: any[] = []) {
  return (rows || []).filter((row) => !row.__error);
}

function firstError(rows: any[] = []) {
  return (rows || []).find((row) => row.__error)?.__error || null;
}

function circuitLockDistinctKey(row: any = {}) {
  return [
    row.market || 'unknown',
    row.symbol || '__market__',
    row.circuit || 'unknown',
  ].join('\u0001');
}

export function distinctCircuitLocks(rows: any[] = []) {
  const byKey = new Map();
  for (const row of rows || []) {
    if (!row || row.__error) continue;
    const key = circuitLockDistinctKey(row);
    const previous = byKey.get(key);
    const currentTs = Date.parse(String(row.evaluated_at || row.evaluatedAt || '')) || 0;
    const previousTs = previous ? Date.parse(String(previous.evaluated_at || previous.evaluatedAt || '')) || 0 : -1;
    if (!previous || currentTs >= previousTs) byKey.set(key, row);
  }
  return Array.from(byKey.values());
}

async function buildDomesticDebrief(queryFn: any, now: Date) {
  const dateKst = kstDateKey(now);
  const morningRows = await safeQuery(queryFn,
    `SELECT id, type, started_at, summary, segments
       FROM luna_meeting_sessions
      WHERE type = 'morning'
        AND (started_at AT TIME ZONE 'Asia/Seoul')::date = $1::date
      ORDER BY started_at DESC
      LIMIT 1`,
    [dateKst]);
  const signalRows = await safeQuery(queryFn,
    `SELECT id, market, symbol, family, signal_type, candle_ts, price, rr, created_at
       FROM luna_strategy_signals
      WHERE market = 'domestic'
        AND (created_at AT TIME ZONE 'Asia/Seoul')::date = $1::date
      ORDER BY created_at DESC
      LIMIT 200`,
    [dateKst]);
  const preflightRows = await safeQuery(queryFn,
    `SELECT strategy_signal_id, market, symbol, family, decision, gates, evaluated_at
       FROM luna_entry_preflight_log
      WHERE market = 'domestic'
        AND (evaluated_at AT TIME ZONE 'Asia/Seoul')::date = $1::date
      ORDER BY evaluated_at DESC
      LIMIT 200`,
    [dateKst]);
  const circuitRows = await safeQuery(queryFn,
    `SELECT DISTINCT ON (market, COALESCE(symbol, '__market__'), circuit)
            market, symbol, side, level, circuit, reason, lock_until, evaluated_at
       FROM luna_circuit_locks
      WHERE market = 'domestic'
        AND locked IS TRUE
        AND shadow_only IS TRUE
        AND (lock_until IS NULL OR lock_until > NOW())
        AND (evaluated_at AT TIME ZONE 'Asia/Seoul')::date = $1::date
      ORDER BY market, COALESCE(symbol, '__market__'), circuit, evaluated_at DESC`,
    [dateKst]);
  const gateRows = await safeQuery(queryFn,
    `SELECT market, COUNT(*)::int AS samples, COUNT(DISTINCT deployment)::int AS deployment_states,
            ARRAY_AGG(DISTINCT deployment) AS deployments
       FROM luna_market_gate_history
      WHERE market = 'domestic'
        AND (computed_at AT TIME ZONE 'Asia/Seoul')::date = $1::date
      GROUP BY market`,
    [dateKst]);
  const regimeRows = await safeQuery(queryFn,
    `SELECT market, COUNT(*)::int AS samples, COUNT(DISTINCT current_regime)::int AS regime_states,
            ARRAY_AGG(DISTINCT current_regime) AS regimes
       FROM hmm_regime_log
      WHERE symbol = '__market__'
        AND market = 'domestic'
        AND (created_at AT TIME ZONE 'Asia/Seoul')::date = $1::date
      GROUP BY market`,
    [dateKst]);
  const tradeRows = await safeQuery(queryFn,
    `SELECT symbol, market, execution_origin, exit_reason, pnl_net, pnl_percent, entry_time, exit_time
       FROM trade_journal
      WHERE market = 'domestic'
        AND (
          (entry_time IS NOT NULL AND (entry_time AT TIME ZONE 'Asia/Seoul')::date = $1::date)
          OR (exit_time IS NOT NULL AND (exit_time AT TIME ZONE 'Asia/Seoul')::date = $1::date)
        )
      ORDER BY COALESCE(exit_time, entry_time) DESC
      LIMIT 100`,
    [dateKst]);

  const signals = cleanRows(signalRows).map((row) => ({ ...row }));
  const preflights = cleanRows(preflightRows).map((row) => ({ ...row, gates: safeJson(row.gates) }));
  const trackedSignalIds = new Set(preflights.map((row) => Number(row.strategy_signal_id)).filter(Boolean));
  const unspokenEntries = signals
    .filter((row) => row.signal_type === 'entry' && !trackedSignalIds.has(Number(row.id)))
    .map((row) => ({
      id: row.id,
      symbol: row.symbol,
      family: row.family,
      reason: 'shadow_stage_virtual_tracking',
    }));

  return {
    dateKst,
    morningSession: cleanRows(morningRows)[0] || null,
    degraded: cleanRows(morningRows).length === 0,
    degradeReason: cleanRows(morningRows).length === 0 ? 'same_day_morning_session_missing' : null,
    strategySignals: signals,
    preflights,
    activeCircuits: distinctCircuitLocks(cleanRows(circuitRows)),
    gateTransitions: cleanRows(gateRows),
    regimeTransitions: cleanRows(regimeRows),
    kisTrades: cleanRows(tradeRows),
    unspokenEntries,
    errors: [
      firstError(morningRows),
      firstError(signalRows),
      firstError(preflightRows),
      firstError(circuitRows),
      firstError(gateRows),
      firstError(regimeRows),
      firstError(tradeRows),
    ].filter(Boolean),
  };
}

async function buildWeeklyStats(queryFn: any, now: Date) {
  const asOfKst = kstDateKey(now);
  const signalRows = await safeQuery(queryFn,
    `SELECT market, family, signal_type, COUNT(*)::int AS count
       FROM luna_strategy_signals
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY market, family, signal_type
      ORDER BY market, family, signal_type`);
  const preflightRows = await safeQuery(queryFn,
    `SELECT market, decision, COUNT(*)::int AS count
       FROM luna_entry_preflight_log
      WHERE evaluated_at >= NOW() - INTERVAL '7 days'
      GROUP BY market, decision
      ORDER BY market, decision`);
  const circuitRows = await safeQuery(queryFn,
    `SELECT market, level, circuit, locked, COUNT(DISTINCT COALESCE(symbol, '__market__'))::int AS count
       FROM luna_circuit_locks
      WHERE evaluated_at >= NOW() - INTERVAL '7 days'
      GROUP BY market, level, circuit, locked
      ORDER BY market, level, circuit`);
  const brierRows = await safeQuery(queryFn,
    `SELECT market, COUNT(*)::int AS samples,
            ROUND(AVG(brier_hmm)::numeric, 6) AS avg_brier_hmm,
            ROUND(AVG(brier_fallback)::numeric, 6) AS avg_brier_fallback
       FROM luna_regime_calibration
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY market
      ORDER BY market`);
  const registryRows = await safeQuery(queryFn,
    `SELECT status, COUNT(*)::int AS count
       FROM luna_component_registry
      WHERE status IN ('stalled', 'proposed', 'active')
      GROUP BY status
      ORDER BY status`);
  const adrRows = await safeQuery(queryFn,
    `SELECT status, COUNT(*)::int AS count
       FROM luna_meeting_decisions
      WHERE created_at >= NOW() - INTERVAL '7 days'
         OR (due_at IS NOT NULL AND due_at < NOW() AND status = 'pending_master')
      GROUP BY status
      ORDER BY status`);
  const overdueRows = await safeQuery(queryFn,
    `SELECT id, session_id, agenda_key, decision, due_at
       FROM luna_meeting_decisions
      WHERE status = 'pending_master'
        AND due_at IS NOT NULL
        AND due_at < NOW()
      ORDER BY due_at ASC
      LIMIT 50`);
  return {
    asOfKst,
    signals: cleanRows(signalRows),
    preflight: cleanRows(preflightRows),
    circuit: cleanRows(circuitRows),
    brier: cleanRows(brierRows),
    registry: cleanRows(registryRows),
    adr: cleanRows(adrRows),
    overdueAdr: cleanRows(overdueRows),
    errors: [
      firstError(signalRows),
      firstError(preflightRows),
      firstError(circuitRows),
      firstError(brierRows),
      firstError(registryRows),
      firstError(adrRows),
      firstError(overdueRows),
    ].filter(Boolean),
  };
}

export async function buildMeetingPlanNote(options: any = {}, deps: any = {}) {
  const type = normalizeMeetingType(options.type || 'morning');
  const now = new Date(options.now || Date.now());
  const queryFn = deps.queryFn || options.queryFn || db.query;
  const generatedAt = now.toISOString();
  const segments = buildMarketSegments(now);

  const gateRows = await safeQuery(queryFn,
    `SELECT DISTINCT ON (market) market, score, deployment, signals, computed_at
       FROM luna_market_gate_history
      ORDER BY market, computed_at DESC`);
  const regimeRows = await safeQuery(queryFn,
    `SELECT DISTINCT ON (market) market, current_regime, regime_probabilities, confidence, source, transition_alert, created_at
       FROM hmm_regime_log
      WHERE symbol = '__market__'
      ORDER BY market, created_at DESC`);
  const signalRows = await safeQuery(queryFn,
    `SELECT id, market, symbol, family, signal_type, candle_ts, price, rr, regime, matched, details, created_at
       FROM luna_strategy_signals
      WHERE created_at >= NOW() - INTERVAL '24 hours'
      ORDER BY created_at DESC
      LIMIT 200`);
  const circuitRows = await safeQuery(queryFn,
    `SELECT DISTINCT ON (market, COALESCE(symbol, '__market__'), circuit)
            market, symbol, side, level, circuit, reason, evidence, lock_until, evaluated_at
       FROM luna_circuit_locks
      WHERE locked IS TRUE
        AND shadow_only IS TRUE
        AND (lock_until IS NULL OR lock_until > NOW())
      ORDER BY market, COALESCE(symbol, '__market__'), circuit, evaluated_at DESC`);
  const registryRows = await safeQuery(queryFn,
    `SELECT component, current_mode, target_mode, status, sample_count, promotion_criteria, last_evaluated_at, registered_at, notes
       FROM luna_component_registry
      WHERE status IN ('stalled', 'proposed', 'active')
      ORDER BY last_evaluated_at DESC NULLS LAST, registered_at DESC
      LIMIT 120`);
  const positionRows = await safeQuery(queryFn,
    `SELECT symbol, exchange, amount, entry_price, updated_at
       FROM positions
      WHERE amount > 0
      ORDER BY updated_at DESC
      LIMIT 80`);
  const calibrationRows = await safeQuery(queryFn,
    `SELECT DISTINCT ON (market) market, as_of_date, brier_hmm, brier_fallback, label, probs, created_at
       FROM luna_regime_calibration
      ORDER BY market, as_of_date DESC`);
  const debrief = type === 'domestic_debrief' ? await buildDomesticDebrief(queryFn, now) : null;
  const weekly = type === 'weekly' ? await buildWeeklyStats(queryFn, now) : null;

  const proposalFile = readJson(options.proposalPath || REGISTRY_PROPOSALS_PATH, { proposals: [], notifyNow: [], deferred: [] }) || {};
  const registryPending = (registryRows || [])
    .filter((row) => !row.__error && (row.status === 'stalled' || row.status === 'proposed' || safeJson(row.promotion_criteria).placeholder === true))
    .slice(0, 20);
  const pendingDecisions = [
    ...(Array.isArray(proposalFile.notifyNow) ? proposalFile.notifyNow : []),
    ...(Array.isArray(proposalFile.deferred) ? proposalFile.deferred : []),
    ...registryPending.map((row) => ({
      type: row.status === 'stalled' ? 'stalled_report' : 'registry_review',
      component: row.component,
      status: row.status,
      sampleCount: row.sample_count,
      criteria: safeJson(row.promotion_criteria),
    })),
  ];

  const gates = latestByMarketRows(gateRows).map((row) => ({ ...row, signals: safeJson(row.signals) }));
  const regimes = latestByMarketRows(regimeRows).map((row) => ({
    ...row,
    probabilities: safeJson(row.regime_probabilities),
    transitionAlert: safeJson(row.transition_alert, null),
  }));
  const strategySignals = (signalRows || []).filter((row) => !row.__error).map((row) => ({
    ...row,
    regime: safeJson(row.regime),
    details: safeJson(row.details),
  }));
  const circuitLocks = distinctCircuitLocks(circuitRows).map((row) => ({
    ...row,
    evidence: safeJson(row.evidence),
  }));
  const positions = (positionRows || []).filter((row) => !row.__error);
  const calibration = latestByMarketRows(calibrationRows).map((row) => ({ ...row, probs: safeJson(row.probs) }));

  const note = {
    ok: true,
    type,
    generatedAt,
    segments,
    gates,
    regimes,
    strategySignals,
    circuitLocks,
    pendingDecisions,
    positions,
    calibration,
    debrief,
    weekly,
    readOnly: true,
    shadowOnly: true,
  };
  return { ...note, briefMarkdown: renderPlanNoteBrief(note) };
}

export function renderPlanNoteBrief(note: any = {}) {
  const gates = new Map((note.gates || []).map((row) => [row.market, row]));
  const regimes = new Map((note.regimes || []).map((row) => [row.market, row]));
  const gateLine = ['domestic', 'overseas', 'crypto'].map((market) => {
    const row = gates.get(market);
    return `${market}:${row ? `${row.deployment || 'n/a'}(${Number(row.score ?? 0).toFixed(0)})` : '없음'}`;
  }).join(' · ');
  const regimeLine = ['domestic', 'overseas', 'crypto'].map((market) => {
    const row = regimes.get(market);
    const dominant = row?.current_regime || '없음';
    const probs = row?.probabilities || {};
    const p = dominant !== '없음' && probs?.[dominant] != null ? Number(probs[dominant]).toFixed(2) : 'n/a';
    return `${market}:${dominant}(${p})`;
  }).join(' · ');
  const entryCount = (note.strategySignals || []).filter((row) => row.signal_type === 'entry' || row.signalType === 'entry').length;
  const activeSegments = (note.segments || []).filter((seg) => seg.active).map((seg) => seg.market).join(', ') || '없음';
  return [
    `# Luna 회의 plan-note (${note.type || 'morning'})`,
    `- 생성: ${note.generatedAt || new Date().toISOString()}`,
    `- 활성 세그먼트: ${activeSegments}`,
    `- G0 게이트: ${gateLine}`,
    `- C2 레짐: ${regimeLine}`,
    `- 전략군 24h: ${note.strategySignals?.length || 0}건(entry ${entryCount})`,
    `- 활성 서킷: ${note.circuitLocks?.length || 0}건`,
    `- 결정 대기: ${note.pendingDecisions?.length || 0}건`,
  ].join('\n');
}

export default {
  buildMeetingPlanNote,
  buildMarketSegments,
  renderPlanNoteBrief,
};
