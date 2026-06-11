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
    `SELECT market, symbol, side, level, circuit, reason, evidence, lock_until, evaluated_at
       FROM luna_circuit_locks
      WHERE locked IS TRUE
        AND shadow_only IS TRUE
        AND (lock_until IS NULL OR lock_until > NOW())
      ORDER BY evaluated_at DESC
      LIMIT 100`);
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
  const circuitLocks = (circuitRows || []).filter((row) => !row.__error).map((row) => ({
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
