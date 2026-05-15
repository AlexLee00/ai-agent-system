// @ts-nocheck

import { query, run } from './db/core.ts';
import {
  ensureLunaPhase2Schema,
  exchangeForLunaPhase2Market,
  normalizeLunaPhase2Market,
  normalizeLunaPhase2Symbol,
} from './luna-weight-vector.ts';

function finiteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round(value, digits = 6) {
  return Number(Number(value || 0).toFixed(digits));
}

function parseJsonMaybe(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeBool(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  const raw = String(value ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(raw)) return true;
  if (['false', '0', 'no', 'n'].includes(raw)) return false;
  return fallback;
}

export function normalizeLunaPaperPromotionGateConfig(config = {}) {
  return {
    minCycles: Math.max(1, finiteNumber(config.minCycles ?? process.env.LUNA_PAPER_PROMOTION_MIN_CYCLES, 3)),
    minConsecutivePasses: Math.max(1, finiteNumber(config.minConsecutivePasses ?? process.env.LUNA_PAPER_PROMOTION_MIN_CONSECUTIVE_PASSES, 3)),
    minAvgConfidence: Math.max(0, Math.min(1, finiteNumber(config.minAvgConfidence ?? process.env.LUNA_PAPER_PROMOTION_MIN_AVG_CONFIDENCE, 0.62))),
    maxOrderUsdt: Math.max(0, finiteNumber(config.maxOrderUsdt ?? process.env.LUNA_MAX_TRADE_USDT, 50)),
  };
}

export async function ensureLunaPaperPromotionGateSchema() {
  await ensureLunaPhase2Schema();
}

export function normalizeLunaPaperPromotionRow(row = {}) {
  const evidence = parseJsonMaybe(row.evidence, {});
  return {
    symbol: normalizeLunaPhase2Symbol(row.symbol),
    market: normalizeLunaPhase2Market(row.market),
    exchange: row.exchange || exchangeForLunaPhase2Market(row.market),
    targetWeight: finiteNumber(row.target_weight ?? row.targetWeight, 0),
    currentWeight: finiteNumber(row.current_weight ?? row.currentWeight, 0),
    deltaWeight: finiteNumber(row.delta_weight ?? row.deltaWeight, 0),
    paperSide: String(row.paper_side ?? row.paperSide ?? 'HOLD').toUpperCase(),
    paperNotionalUsdt: finiteNumber(row.paper_notional_usdt ?? row.paperNotionalUsdt, 0),
    confidence: finiteNumber(row.confidence, 0),
    status: String(row.status || 'planned'),
    shadowOnly: normalizeBool(row.shadow_only ?? row.shadowOnly, true),
    evidence,
    observedAt: row.observed_at || row.observedAt || new Date().toISOString(),
  };
}

function getBottleneckAvoidance(row = {}) {
  return row.evidence?.bottleneckAvoidance || {};
}

function noLookaheadOk(row = {}) {
  const value = row.evidence?.weightVector?.noLookaheadOk
    ?? row.evidence?.weightVector?.evidence?.noLookahead?.ok
    ?? true;
  return normalizeBool(value, true);
}

function isPaperPass(row = {}) {
  const bottleneck = getBottleneckAvoidance(row);
  return row.paperSide === 'BUY'
    && row.status === 'planned'
    && row.paperNotionalUsdt > 0
    && normalizeBool(row.shadowOnly, true) === true
    && normalizeBool(bottleneck.hardHold, false) === false
    && noLookaheadOk(row) === true;
}

export function evaluateLunaPaperPromotionHistory(rows = [], config = {}) {
  const cfg = normalizeLunaPaperPromotionGateConfig(config);
  const history = (rows || [])
    .map(normalizeLunaPaperPromotionRow)
    .filter((row) => row.symbol)
    .sort((a, b) => new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime());
  const head = history[0] || {};
  let consecutivePasses = 0;
  for (const row of history) {
    if (!isPaperPass(row)) break;
    consecutivePasses += 1;
  }

  const passRows = history.filter(isPaperPass);
  const hardHoldRows = history.filter((row) => normalizeBool(getBottleneckAvoidance(row).hardHold, false));
  const preventedRows = history.filter((row) => normalizeBool(getBottleneckAvoidance(row).preventedOrder, false));
  const noLookaheadViolationRows = history.filter((row) => noLookaheadOk(row) === false);
  const overCapRows = history.filter((row) => row.paperNotionalUsdt > cfg.maxOrderUsdt + 0.000001);
  const avgConfidence = history.length
    ? history.reduce((sum, row) => sum + row.confidence, 0) / history.length
    : 0;
  const totalPaperNotionalUsdt = history.reduce((sum, row) => sum + Math.max(0, row.paperNotionalUsdt), 0);

  const blockReasons = [
    history.length < cfg.minCycles ? 'insufficient_shadow_cycles' : null,
    consecutivePasses < cfg.minConsecutivePasses ? 'insufficient_consecutive_paper_passes' : null,
    avgConfidence < cfg.minAvgConfidence ? 'avg_confidence_below_promotion_floor' : null,
    passRows.length === 0 ? 'no_paper_buy_pass' : null,
    hardHoldRows.length > 0 ? 'candidate_bottleneck_hard_hold_seen' : null,
    preventedRows.length > 0 ? 'candidate_bottleneck_prevented_order_seen' : null,
    noLookaheadViolationRows.length > 0 ? 'no_lookahead_violation_seen' : null,
    overCapRows.length > 0 ? 'paper_order_cap_violation_seen' : null,
  ].filter(Boolean);

  const promotionCandidate = blockReasons.length === 0;
  const decision = promotionCandidate
    ? 'shadow_promotion_candidate_ready'
    : passRows.length > 0
      ? 'shadow_promotion_observe'
      : 'shadow_promotion_blocked';

  return {
    ok: true,
    symbol: head.symbol || null,
    market: normalizeLunaPhase2Market(head.market || 'crypto'),
    exchange: head.exchange || exchangeForLunaPhase2Market(head.market || 'crypto'),
    decision,
    promotionCandidate,
    cycleCount: history.length,
    passCount: passRows.length,
    consecutivePasses,
    avgConfidence: round(avgConfidence, 4),
    totalPaperNotionalUsdt: round(totalPaperNotionalUsdt, 4),
    blockReasons,
    shadowOnly: true,
    liveMutation: false,
    evidence: {
      phase: 'luna_phase2_finrlx',
      source: 'paper_promotion_gate_shadow',
      config: cfg,
      latestObservedAt: head.observedAt || null,
      latestPaperSide: head.paperSide || null,
      latestStatus: head.status || null,
      hardHoldCount: hardHoldRows.length,
      preventedOrderCount: preventedRows.length,
      noLookaheadViolationCount: noLookaheadViolationRows.length,
      overCapCount: overCapRows.length,
      recent: history.slice(0, Math.max(cfg.minCycles, 5)).map((row) => ({
        observedAt: row.observedAt,
        paperSide: row.paperSide,
        status: row.status,
        paperNotionalUsdt: round(row.paperNotionalUsdt, 4),
        confidence: round(row.confidence, 4),
        bottleneckAction: getBottleneckAvoidance(row).action || null,
        bottleneckHardHold: normalizeBool(getBottleneckAvoidance(row).hardHold, false),
        noLookaheadOk: noLookaheadOk(row),
        pass: isPaperPass(row),
      })),
      promotionRequiresExplicitMasterApproval: true,
      liveMutation: false,
    },
  };
}

export function buildLunaPaperPromotionGateReport(rows = [], config = {}) {
  const groups = new Map();
  for (const row of rows || []) {
    const normalized = normalizeLunaPaperPromotionRow(row);
    if (!normalized.symbol) continue;
    const key = `${normalized.symbol}|${normalized.market}`;
    const next = groups.get(key) || [];
    next.push(normalized);
    groups.set(key, next);
  }
  const items = [...groups.values()]
    .map((history) => evaluateLunaPaperPromotionHistory(history, config))
    .sort((a, b) => {
      if (a.promotionCandidate !== b.promotionCandidate) return a.promotionCandidate ? -1 : 1;
      if (a.consecutivePasses !== b.consecutivePasses) return b.consecutivePasses - a.consecutivePasses;
      return b.avgConfidence - a.avgConfidence;
    });
  return {
    ok: true,
    status: 'luna_paper_promotion_gate_shadow_ready',
    phase: 'luna_phase2_finrlx',
    shadowMode: true,
    promotionReady: false,
    requiredApproval: 'explicit_master_live_promotion_approval',
    summary: {
      totalSymbols: items.length,
      promotionCandidates: items.filter((item) => item.promotionCandidate).length,
      observe: items.filter((item) => item.decision === 'shadow_promotion_observe').length,
      blocked: items.filter((item) => item.decision === 'shadow_promotion_blocked').length,
      liveMutation: false,
    },
    items,
  };
}

export async function loadLunaPaperPromotionRows({ hours = 24, limit = 500, market = null } = {}) {
  const params = [Math.max(1, Number(hours)), Math.max(1, Number(limit))];
  const marketWhere = market ? `AND market = $${params.push(normalizeLunaPhase2Market(market))}` : '';
  return query(`
    SELECT symbol, market, exchange, target_weight, current_weight, delta_weight,
           paper_side, paper_notional_usdt, confidence, status, shadow_only,
           evidence, observed_at
      FROM luna_paper_trading_shadow
     WHERE observed_at >= NOW() - ($1::int * INTERVAL '1 hour')
       AND shadow_only IS TRUE
       ${marketWhere}
     ORDER BY symbol, market, observed_at DESC
     LIMIT $2
  `, params).catch(() => []);
}

export async function insertLunaPaperPromotionGateShadow(row = {}) {
  await run(`
    INSERT INTO luna_paper_promotion_gate_shadow
      (symbol, market, exchange, decision, promotion_candidate, cycle_count,
       pass_count, consecutive_passes, avg_confidence, total_paper_notional_usdt,
       block_reasons, shadow_only, evidence)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,true,$12::jsonb)
  `, [
    row.symbol,
    row.market,
    row.exchange,
    row.decision,
    row.promotionCandidate === true,
    row.cycleCount,
    row.passCount,
    row.consecutivePasses,
    row.avgConfidence,
    row.totalPaperNotionalUsdt,
    JSON.stringify(row.blockReasons || []),
    JSON.stringify(row.evidence || {}),
  ]);
}

export default {
  buildLunaPaperPromotionGateReport,
  ensureLunaPaperPromotionGateSchema,
  evaluateLunaPaperPromotionHistory,
  insertLunaPaperPromotionGateShadow,
  loadLunaPaperPromotionRows,
};
