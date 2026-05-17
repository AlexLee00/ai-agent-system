// @ts-nocheck

import { query, run } from './db/core.ts';
import {
  ensureLunaPhase2Schema,
  exchangeForLunaPhase2Market,
  normalizeLunaPhase2Market,
  normalizeLunaPhase2Symbol,
  normalizeLunaPhase2Symbols,
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

export const LUNA_PAPER_PROMOTION_LOADER_LIMIT_SEMANTICS = 'per_symbol_history_cap';

export function normalizeLunaPaperPromotionGateConfig(config = {}) {
  return {
    minCycles: Math.max(1, finiteNumber(config.minCycles ?? process.env.LUNA_PAPER_PROMOTION_MIN_CYCLES, 3)),
    minConsecutivePasses: Math.max(1, finiteNumber(config.minConsecutivePasses ?? process.env.LUNA_PAPER_PROMOTION_MIN_CONSECUTIVE_PASSES, 3)),
    minAvgConfidence: Math.max(0, Math.min(1, finiteNumber(config.minAvgConfidence ?? process.env.LUNA_PAPER_PROMOTION_MIN_AVG_CONFIDENCE, 0.62))),
    maxOrderUsdt: Math.max(0, finiteNumber(config.maxOrderUsdt ?? process.env.LUNA_MAX_TRADE_USDT, 50)),
    maxPromotionSharpe: Math.max(1, finiteNumber(config.maxPromotionSharpe ?? process.env.LUNA_PAPER_PROMOTION_MAX_SHARPE, 8)),
  };
}

export function normalizeLunaPaperPromotionLoaderConfig(config = {}) {
  return {
    hours: Math.max(1, finiteNumber(config.hours ?? 24, 24)),
    perSymbolHistoryLimit: Math.max(1, finiteNumber(config.limit ?? process.env.LUNA_PAPER_PROMOTION_HISTORY_LIMIT_PER_SYMBOL, 500)),
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
    promotionBacktestQuality: evidence?.promotionBacktestQuality || {},
    promotionStrategyQuality: evidence?.promotionStrategyQuality || evidence?.strategyQualityAudit || evidence?.weightVector?.evidence?.strategyQuality || {},
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

function clamp01(value) {
  return Math.max(0, Math.min(1, finiteNumber(value, 0)));
}

function promotionBlockerClass(blockReasons = [], promotionCandidate = false) {
  if (promotionCandidate) return 'ready_for_master_review';
  const reasons = new Set(blockReasons || []);
  if ([
    'candidate_bottleneck_hard_hold_seen',
    'candidate_bottleneck_prevented_order_seen',
    'no_lookahead_violation_seen',
    'paper_order_cap_violation_seen',
    'strategy_quality_block_live_forward_seen',
  ].some((reason) => reasons.has(reason))) return 'risk_quality';
  if ([
    'fallback_only_backtest_seen',
    'non_vectorbt_backtest_seen',
    'missing_backtest_quality_seen',
    'missing_strategy_quality_seen',
    'unrealistic_sharpe_seen',
    'strategy_hyperopt_planned_seen',
    'strategy_quality_not_shadow_ready_seen',
  ].some((reason) => reasons.has(reason))) return 'strategy_or_backtest_quality';
  if (reasons.has('no_paper_buy_pass')) return 'paper_buy_absent';
  if (reasons.has('insufficient_shadow_cycles') || reasons.has('insufficient_consecutive_paper_passes')) return 'paper_cycles';
  if (reasons.has('avg_confidence_below_promotion_floor')) return 'confidence';
  return 'shadow_observation';
}

function buildNextRequiredEvidence({
  blockReasons = [],
  cyclesRemaining = 0,
  consecutivePassesRemaining = 0,
  confidenceGap = 0,
  promotionCandidate = false,
} = {}) {
  if (promotionCandidate) {
    return [{
      type: 'master_review',
      action: 'explicit_master_live_promotion_review',
      detail: 'Shadow evidence is promotion-candidate ready; live priority still requires explicit master approval.',
    }];
  }
  const reasons = new Set(blockReasons || []);
  const evidence = [];
  if (reasons.has('no_paper_buy_pass')) {
    evidence.push({
      type: 'paper_buy_pass',
      action: 'continue_shadow_weight_vector_and_paper_trading',
      detail: 'Need at least one shadow BUY pass before promotion can be considered.',
    });
  }
  if (cyclesRemaining > 0 || consecutivePassesRemaining > 0) {
    evidence.push({
      type: 'paper_cycles',
      action: 'continue_shadow_paper_cycles',
      remainingCycles: cyclesRemaining,
      remainingConsecutivePasses: consecutivePassesRemaining,
      detail: 'Need additional consecutive shadow paper BUY passes with no hard-hold, no lookahead violation, and cap-safe notional.',
    });
  }
  if (confidenceGap > 0) {
    evidence.push({
      type: 'confidence',
      action: 'improve_prediction_and_weight_vector_confidence',
      confidenceGap: round(confidenceGap, 4),
      detail: 'Average paper confidence is below the promotion floor.',
    });
  }
  if (
    reasons.has('fallback_only_backtest_seen')
    || reasons.has('non_vectorbt_backtest_seen')
    || reasons.has('missing_backtest_quality_seen')
    || reasons.has('unrealistic_sharpe_seen')
  ) {
    evidence.push({
      type: 'backtest_quality',
      action: 'refresh_vectorbt_backtest_before_promotion',
      detail: 'Promotion evidence needs stable vectorbt-backed backtest quality, not fallback-only or unrealistic Sharpe evidence.',
    });
  }
  if (
    reasons.has('missing_strategy_quality_seen')
    || reasons.has('strategy_hyperopt_planned_seen')
    || reasons.has('strategy_quality_not_shadow_ready_seen')
  ) {
    evidence.push({
      type: 'strategy_quality',
      action: 'complete_phase4_strategy_enhancement_shadow',
      detail: 'Strategy quality must reach a shadow-ready status before promotion review.',
    });
  }
  if ([
    'candidate_bottleneck_hard_hold_seen',
    'candidate_bottleneck_prevented_order_seen',
    'strategy_quality_block_live_forward_seen',
    'no_lookahead_violation_seen',
    'paper_order_cap_violation_seen',
  ].some((reason) => reasons.has(reason))) {
    evidence.push({
      type: 'risk_quality',
      action: 'keep_candidate_blocked_until_risk_evidence_clears',
      detail: 'Risk-quality blockers must clear in later shadow cycles before promotion review.',
    });
  }
  return evidence.length ? evidence : [{
    type: 'shadow_observation',
    action: 'continue_shadow_observation',
    detail: 'No single hard blocker class dominates; continue shadow evidence accumulation.',
  }];
}

function buildPromotionReadinessGap({
  history = [],
  passRows = [],
  consecutivePasses = 0,
  avgConfidence = 0,
  blockReasons = [],
  promotionCandidate = false,
  cfg = {},
} = {}) {
  const cyclesRemaining = Math.max(0, finiteNumber(cfg.minCycles, 3) - history.length);
  const consecutivePassesRemaining = Math.max(0, finiteNumber(cfg.minConsecutivePasses, 3) - consecutivePasses);
  const confidenceGap = Math.max(0, finiteNumber(cfg.minAvgConfidence, 0.62) - avgConfidence);
  const blockerClass = promotionBlockerClass(blockReasons, promotionCandidate);
  const hardRiskPenalty = blockerClass === 'risk_quality' ? 0.3 : 0;
  const qualityPenalty = blockerClass === 'strategy_or_backtest_quality' ? 0.18 : 0;
  const noBuyPenalty = blockerClass === 'paper_buy_absent' ? 0.2 : 0;
  const readinessScore = clamp01(
    clamp01(history.length / Math.max(1, cfg.minCycles)) * 0.25
    + clamp01(consecutivePasses / Math.max(1, cfg.minConsecutivePasses)) * 0.35
    + clamp01(avgConfidence / Math.max(0.000001, cfg.minAvgConfidence)) * 0.25
    + (passRows.length > 0 ? 0.15 : 0)
    - hardRiskPenalty
    - qualityPenalty
    - noBuyPenalty,
  );
  return {
    cyclesRemaining,
    consecutivePassesRemaining,
    confidenceGap: round(confidenceGap, 4),
    readinessScore: round(readinessScore, 4),
    promotionBlockerClass: blockerClass,
    nextRequiredEvidence: buildNextRequiredEvidence({
      blockReasons,
      cyclesRemaining,
      consecutivePassesRemaining,
      confidenceGap,
      promotionCandidate,
    }),
  };
}

function getPromotionBacktestQuality(row = {}, config = {}) {
  const quality = row.promotionBacktestQuality || row.evidence?.promotionBacktestQuality || {};
  const fallbackUsed = normalizeBool(quality.fallbackUsed, false);
  const vectorbtEnabled = normalizeBool(quality.vectorbtEnabled, false);
  const sharpe = finiteNumber(quality.sharpe, null);
  const maxPromotionSharpe = finiteNumber(config.maxPromotionSharpe, 8);
  const reasons = [
    fallbackUsed && !vectorbtEnabled ? 'fallback_only_backtest' : null,
    !vectorbtEnabled ? 'non_vectorbt_backtest' : null,
    sharpe != null && Math.abs(sharpe) > maxPromotionSharpe ? 'unrealistic_sharpe' : null,
  ].filter(Boolean);
  return {
    present: Object.keys(quality || {}).length > 0,
    fallbackUsed,
    vectorbtEnabled,
    sharpe,
    maxPromotionSharpe,
    stable: reasons.length === 0,
    reasons,
  };
}

function isStrategyQualityReadyStatus(status = '') {
  return [
    'shadow_ready',
    'shadow_ready_with_risk_tightening',
    'shadow_tuned',
    'shadow_evaluated',
  ].includes(String(status || '').trim());
}

function getPromotionStrategyQuality(row = {}) {
  const quality = row.promotionStrategyQuality
    || row.evidence?.promotionStrategyQuality
    || row.evidence?.strategyQualityAudit
    || row.evidence?.weightVector?.evidence?.strategyQuality
    || {};
  const enhancementStatus = String(quality.enhancementStatus ?? quality.enhancement_status ?? '').trim();
  const hyperoptStatus = String(quality.hyperoptStatus ?? quality.hyperopt_status ?? '').trim();
  const maxDrawdownGuard = String(quality.maxDrawdownGuard ?? quality.max_drawdown_guard ?? '').trim();
  const indicatorScore = finiteNumber(quality.indicatorScore ?? quality.indicator_score, 0);
  const hardHold = normalizeBool(quality.hardHold ?? quality.hard_hold, false) || maxDrawdownGuard === 'block_live_forward';
  const readyStatus = !enhancementStatus || isStrategyQualityReadyStatus(enhancementStatus);
  const reasons = [
    hardHold ? 'strategy_quality_block_live_forward' : null,
    maxDrawdownGuard === 'tighten_risk' ? 'strategy_quality_tighten_risk' : null,
    hyperoptStatus === 'planned' ? 'strategy_hyperopt_planned' : null,
    !readyStatus ? 'strategy_quality_not_shadow_ready' : null,
  ].filter(Boolean);
  return {
    present: Object.keys(quality || {}).length > 0,
    enhancementStatus: enhancementStatus || null,
    hyperoptStatus: hyperoptStatus || null,
    maxDrawdownGuard: maxDrawdownGuard || null,
    indicatorScore,
    hardHold,
    stable: reasons.length === 0,
    reasons,
  };
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
  const backtestQualityRows = history
    .map((row) => getPromotionBacktestQuality(row, cfg))
    .filter((quality) => quality.present);
  const latestBacktestQuality = getPromotionBacktestQuality(history[0] || {}, cfg);
  const latestStrategyQuality = getPromotionStrategyQuality(history[0] || {});
  const fallbackOnlyRows = backtestQualityRows.filter((quality) => quality.reasons.includes('fallback_only_backtest'));
  const nonVectorbtRows = backtestQualityRows.filter((quality) => quality.reasons.includes('non_vectorbt_backtest'));
  const unrealisticSharpeRows = backtestQualityRows.filter((quality) => quality.reasons.includes('unrealistic_sharpe'));
  const strategyQualityRows = history
    .map((row) => getPromotionStrategyQuality(row))
    .filter((quality) => quality.present);
  const strategyHardHoldRows = strategyQualityRows.filter((quality) => quality.reasons.includes('strategy_quality_block_live_forward'));
  const strategyHyperoptPlannedRows = strategyQualityRows.filter((quality) => quality.reasons.includes('strategy_hyperopt_planned'));
  const strategyNotReadyRows = strategyQualityRows.filter((quality) => quality.reasons.includes('strategy_quality_not_shadow_ready'));
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
    !latestBacktestQuality.present ? 'missing_backtest_quality_seen' : null,
    fallbackOnlyRows.length > 0 ? 'fallback_only_backtest_seen' : null,
    nonVectorbtRows.length > 0 ? 'non_vectorbt_backtest_seen' : null,
    unrealisticSharpeRows.length > 0 ? 'unrealistic_sharpe_seen' : null,
    !latestStrategyQuality.present ? 'missing_strategy_quality_seen' : null,
    strategyHardHoldRows.length > 0 ? 'strategy_quality_block_live_forward_seen' : null,
    strategyHyperoptPlannedRows.length > 0 ? 'strategy_hyperopt_planned_seen' : null,
    strategyNotReadyRows.length > 0 ? 'strategy_quality_not_shadow_ready_seen' : null,
  ].filter(Boolean);

  const promotionCandidate = blockReasons.length === 0;
  const readinessGap = buildPromotionReadinessGap({
    history,
    passRows,
    consecutivePasses,
    avgConfidence,
    blockReasons,
    promotionCandidate,
    cfg,
  });
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
    cyclesRemaining: readinessGap.cyclesRemaining,
    consecutivePassesRemaining: readinessGap.consecutivePassesRemaining,
    confidenceGap: readinessGap.confidenceGap,
    readinessScore: readinessGap.readinessScore,
    promotionBlockerClass: readinessGap.promotionBlockerClass,
    nextRequiredEvidence: readinessGap.nextRequiredEvidence,
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
      missingBacktestQuality: !latestBacktestQuality.present,
      fallbackOnlyBacktestCount: fallbackOnlyRows.length,
      nonVectorbtBacktestCount: nonVectorbtRows.length,
      unrealisticSharpeCount: unrealisticSharpeRows.length,
      missingStrategyQuality: !latestStrategyQuality.present,
      strategyQualityHardHoldCount: strategyHardHoldRows.length,
      strategyHyperoptPlannedCount: strategyHyperoptPlannedRows.length,
      strategyNotReadyCount: strategyNotReadyRows.length,
      backtestQualityMaxSharpe: cfg.maxPromotionSharpe,
      readinessGap,
      recent: history.slice(0, Math.max(cfg.minCycles, 5)).map((row) => ({
        observedAt: row.observedAt,
        paperSide: row.paperSide,
        status: row.status,
        paperNotionalUsdt: round(row.paperNotionalUsdt, 4),
        confidence: round(row.confidence, 4),
        bottleneckAction: getBottleneckAvoidance(row).action || null,
        bottleneckHardHold: normalizeBool(getBottleneckAvoidance(row).hardHold, false),
        noLookaheadOk: noLookaheadOk(row),
        backtestQuality: getPromotionBacktestQuality(row, cfg),
        strategyQuality: getPromotionStrategyQuality(row),
        pass: isPaperPass(row),
      })),
      promotionRequiresExplicitMasterApproval: true,
      liveMutation: false,
    },
  };
}

function topBlockReasonSummary(items = []) {
  const counts = {};
  for (const item of items || []) {
    for (const reason of item.blockReasons || []) {
      counts[reason] = (counts[reason] || 0) + 1;
    }
  }
  return Object.entries(counts)
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
    .slice(0, 10);
}

function isNearReadyPromotionItem(item = {}) {
  return item.promotionCandidate !== true
    && item.passCount > 0
    && item.readinessScore >= 0.55
    && ['paper_cycles', 'confidence', 'shadow_observation'].includes(item.promotionBlockerClass);
}

function nextPaperCycleTargets(items = [], limit = 10) {
  return (items || [])
    .filter((item) => item.promotionCandidate !== true)
    .filter((item) => item.passCount > 0 || item.promotionBlockerClass === 'paper_cycles')
    .sort((a, b) => b.readinessScore - a.readinessScore || b.consecutivePasses - a.consecutivePasses || b.avgConfidence - a.avgConfidence)
    .slice(0, limit)
    .map((item) => ({
      symbol: item.symbol,
      market: item.market,
      exchange: item.exchange,
      readinessScore: item.readinessScore,
      promotionBlockerClass: item.promotionBlockerClass,
      cyclesRemaining: item.cyclesRemaining,
      consecutivePassesRemaining: item.consecutivePassesRemaining,
      confidenceGap: item.confidenceGap,
      blockReasons: item.blockReasons,
      nextRequiredEvidence: item.nextRequiredEvidence,
    }));
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
      if (a.readinessScore !== b.readinessScore) return b.readinessScore - a.readinessScore;
      if (a.consecutivePasses !== b.consecutivePasses) return b.consecutivePasses - a.consecutivePasses;
      return b.avgConfidence - a.avgConfidence;
    });
  const nearReadyItems = items.filter(isNearReadyPromotionItem);
  const promotionTargets = nextPaperCycleTargets(items);
  const topBlockers = topBlockReasonSummary(items);
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
      nearReady: nearReadyItems.length,
      avgReadinessScore: round(items.reduce((sum, item) => sum + item.readinessScore, 0) / Math.max(1, items.length), 4),
      topBlockers,
      nextPaperCycleTargets: promotionTargets,
      liveMutation: false,
    },
    readinessSummary: {
      nearReady: nearReadyItems.length,
      topBlockers,
      nextPaperCycleTargets: promotionTargets,
      promotionRequiresExplicitMasterApproval: true,
      liveMutation: false,
    },
    items,
  };
}

export function buildLunaPaperPromotionRowsSql({ marketWhere = '', symbolWhere = '' } = {}) {
  return `
    WITH latest_strategy AS (
      SELECT DISTINCT ON (symbol, market)
             symbol, market, enhancement_status, hyperopt_status, max_drawdown_guard,
             indicator_score, provider_status, reasons, observed_at
        FROM luna_phase4_strategy_enhancement_shadow
       WHERE shadow_only IS TRUE
         AND observed_at >= NOW() - INTERVAL '24 hours'
       ORDER BY symbol, market, observed_at DESC
    ),
    paper_rows AS (
      SELECT pts.symbol, pts.market, pts.exchange, pts.target_weight, pts.current_weight, pts.delta_weight,
             pts.paper_side, pts.paper_notional_usdt, pts.confidence, pts.status, pts.shadow_only,
           CASE
             WHEN cbs.symbol IS NULL THEN pts.evidence
             ELSE jsonb_set(
               COALESCE(pts.evidence, '{}'::jsonb),
               '{promotionBacktestQuality}',
               jsonb_build_object(
                 'fresh', cbs.fresh,
                 'healthy', cbs.healthy,
                 'sharpe', cbs.sharpe,
                 'winRate', cbs.win_rate,
                 'gateStatus', cbs.gate_status,
                 'fallbackUsed', COALESCE((cbs.backtest_run_metadata->>'fallbackUsed')::boolean, false),
                 'vectorbtEnabled', COALESCE((cbs.backtest_run_metadata->>'vectorbtEnabled')::boolean, false),
                 'lastBacktestAt', cbs.last_backtest_at
               ),
               true
             )
           END AS evidence_with_backtest,
             pts.observed_at,
             ROW_NUMBER() OVER (
               PARTITION BY pts.symbol, pts.market
               ORDER BY pts.observed_at DESC
             ) AS symbol_history_rank
        FROM luna_paper_trading_shadow pts
        LEFT JOIN candidate_backtest_status cbs
          ON cbs.symbol = pts.symbol
         AND cbs.market = pts.market
       WHERE pts.observed_at >= NOW() - ($1::int * INTERVAL '1 hour')
         AND pts.shadow_only IS TRUE
         ${marketWhere}
         ${symbolWhere}
    )
    SELECT pr.symbol, pr.market, pr.exchange, pr.target_weight, pr.current_weight, pr.delta_weight,
           pr.paper_side, pr.paper_notional_usdt, pr.confidence, pr.status, pr.shadow_only,
           CASE
             WHEN ls.symbol IS NULL THEN pr.evidence_with_backtest
             ELSE jsonb_set(
               COALESCE(pr.evidence_with_backtest, '{}'::jsonb),
               '{promotionStrategyQuality}',
               jsonb_build_object(
                 'enhancementStatus', ls.enhancement_status,
                 'hyperoptStatus', ls.hyperopt_status,
                 'maxDrawdownGuard', ls.max_drawdown_guard,
                 'indicatorScore', ls.indicator_score,
                 'providerStatus', ls.provider_status,
                 'reasons', COALESCE(ls.reasons, '[]'::jsonb),
                 'observedAt', ls.observed_at,
                 'source', 'luna_phase4_strategy_enhancement_shadow'
               ),
               true
             )
           END AS evidence,
           pr.observed_at
      FROM paper_rows pr
      LEFT JOIN latest_strategy ls
        ON ls.symbol = pr.symbol
       AND ls.market = pr.market
     WHERE pr.symbol_history_rank <= $2
     ORDER BY pr.symbol, pr.market, pr.observed_at DESC
  `;
}

export async function loadLunaPaperPromotionRows({ hours = 24, limit = 500, market = null, symbols = [] } = {}) {
  const loaderConfig = normalizeLunaPaperPromotionLoaderConfig({ hours, limit });
  const params = [loaderConfig.hours, loaderConfig.perSymbolHistoryLimit];
  const requestedMarket = String(market || '').trim().toLowerCase();
  const normalizedMarket = requestedMarket && requestedMarket !== 'all'
    ? normalizeLunaPhase2Market(requestedMarket)
    : null;
  const requestedSymbols = normalizeLunaPhase2Symbols(symbols);
  const marketWhere = normalizedMarket ? `AND pts.market = $${params.push(normalizedMarket)}` : '';
  const symbolWhere = requestedSymbols.length ? `AND pts.symbol = ANY($${params.push(requestedSymbols)}::text[])` : '';
  return query(buildLunaPaperPromotionRowsSql({ marketWhere, symbolWhere }), params).catch(() => []);
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
  buildLunaPaperPromotionRowsSql,
  ensureLunaPaperPromotionGateSchema,
  evaluateLunaPaperPromotionHistory,
  insertLunaPaperPromotionGateShadow,
  LUNA_PAPER_PROMOTION_LOADER_LIMIT_SEMANTICS,
  loadLunaPaperPromotionRows,
  normalizeLunaPaperPromotionLoaderConfig,
};
