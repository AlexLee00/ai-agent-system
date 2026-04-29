// @ts-nocheck
/**
 * Pure-ish decision pipeline helpers.
 *
 * The runner keeps stage orchestration; this module owns classification,
 * symbol list, and representative-pass policy so state-machine migration can
 * happen with smaller seams.
 */

import { ACTIONS, ANALYST_TYPES } from './signal.ts';
import { getOpenPositions, getCapitalConfigWithOverrides } from './capital-manager.ts';

export function isActuallyExecuted(resultItem) {
  const execution = resultItem?.execution;
  if (!execution || execution.skipped) return false;
  if (execution.trade) return true;
  if (execution.signalStatus === 'executed') return true;
  if (execution.execution?.success && !execution.execution?.absorbed) return true;
  return false;
}

export function isExecutionStillApproved(resultItem) {
  if (isActuallyExecuted(resultItem)) return true;
  const signalStatus = resultItem?.signalStatus ?? resultItem?.execution?.signalStatus ?? null;
  return signalStatus === 'approved';
}

export function buildAnalystSignals(analyses) {
  const getChar = s => !s ? 'N' : s.toUpperCase() === 'BUY' ? 'B' : s.toUpperCase() === 'SELL' ? 'S' : 'N';
  const sentinelSignal = analyses.find(a => a.analyst === ANALYST_TYPES.SENTINEL)?.signal;
  return [
    `A:${getChar(analyses.find(a => a.analyst === ANALYST_TYPES.TA_MTF)?.signal)}`,
    `O:${getChar(analyses.find(a => a.analyst === ANALYST_TYPES.ONCHAIN)?.signal)}`,
    `H:${getChar(analyses.find(a => a.analyst === ANALYST_TYPES.NEWS)?.signal || sentinelSignal)}`,
    `S:${getChar(analyses.find(a => a.analyst === ANALYST_TYPES.SENTIMENT)?.signal || sentinelSignal)}`,
  ].join('|');
}

export function normalizeCollectQuality(...candidates) {
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && candidate.status) {
      return {
        status: String(candidate.status || 'ready'),
        collectMode: String(candidate.collectMode || 'screening'),
        readinessScore: Number(candidate.readinessScore || 1),
        reasons: Array.isArray(candidate.reasons) ? candidate.reasons : [],
      };
    }
  }
  return {
    status: 'ready',
    collectMode: 'screening',
    readinessScore: 1,
    reasons: [],
  };
}

export function applyCollectQualityGuard(portfolioDecision, collectQuality) {
  if (!portfolioDecision || !Array.isArray(portfolioDecision.decisions)) {
    return { portfolioDecision, reducedBuyCount: 0, blockedBuyCount: 0 };
  }

  const qualityStatus = String(collectQuality?.status || 'ready');
  if (qualityStatus === 'ready') {
    return { portfolioDecision, reducedBuyCount: 0, blockedBuyCount: 0 };
  }

  let reducedBuyCount = 0;
  let blockedBuyCount = 0;
  const reasonSuffix = Array.isArray(collectQuality?.reasons) && collectQuality.reasons.length > 0
    ? ` (${collectQuality.reasons.join(', ')})`
    : '';

  const decisions = portfolioDecision.decisions.map((decision) => {
    if (decision?.action !== ACTIONS.BUY) return decision;

    if (qualityStatus === 'insufficient') {
      blockedBuyCount += 1;
      return {
        ...decision,
        action: ACTIONS.HOLD,
        amount_usdt: 0,
        reasoning: `collect quality insufficient${reasonSuffix} | ${decision.reasoning || '신규 진입 보류'}`.slice(0, 180),
      };
    }

    reducedBuyCount += 1;
    return {
      ...decision,
      confidence: Math.max(0.12, Math.min(1, Number((Number(decision.confidence || 0) * 0.88).toFixed(4)))),
      reasoning: `collect quality degraded${reasonSuffix} | ${decision.reasoning || '신규 진입 보수화'}`.slice(0, 180),
    };
  });

  return {
    portfolioDecision: {
      ...portfolioDecision,
      decisions,
      collectQualityGuard: {
        status: qualityStatus,
        readinessScore: Number(collectQuality?.readinessScore || 0),
        blockedBuyCount,
        reducedBuyCount,
        reasons: Array.isArray(collectQuality?.reasons) ? collectQuality.reasons : [],
      },
    },
    reducedBuyCount,
    blockedBuyCount,
  };
}

export async function applyRuntimeCryptoRepresentativePass({ portfolioDecision, exchange, investmentTradeMode }) {
  if (exchange !== 'binance' || investmentTradeMode !== 'normal') {
    return { decision: portfolioDecision, reduction: null };
  }

  const decisions = Array.isArray(portfolioDecision?.decisions) ? [...portfolioDecision.decisions] : [];
  const buyDecisions = decisions.filter((item) => item?.action === ACTIONS.BUY);
  if (buyDecisions.length <= 1) {
    return { decision: portfolioDecision, reduction: null };
  }

  const [openPositions, capitalPolicy] = await Promise.all([
    getOpenPositions(exchange, false, 'normal').catch(() => []),
    getCapitalConfigWithOverrides(exchange, 'normal').catch(() => ({})),
  ]);

  const maxSameDirection = Number(capitalPolicy?.max_same_direction_positions || 3);
  const currentLongCount = Array.isArray(openPositions) ? openPositions.length : 0;
  const remainingLongSlots = Math.max(0, maxSameDirection - currentLongCount);

  if (buyDecisions.length <= remainingLongSlots) {
    return { decision: portfolioDecision, reduction: null };
  }

  const sortedBuys = [...buyDecisions].sort((a, b) => {
    const confidenceGap = Number(b?.confidence || 0) - Number(a?.confidence || 0);
    if (confidenceGap !== 0) return confidenceGap;
    const amountGap = Number(b?.amount_usdt || 0) - Number(a?.amount_usdt || 0);
    if (amountGap !== 0) return amountGap;
    return String(a?.symbol || '').localeCompare(String(b?.symbol || ''));
  });

  const keepBuySet = new Set(sortedBuys.slice(0, remainingLongSlots).map((item) => item.symbol));
  const kept = [];
  const dropped = [];
  const nextDecisions = decisions.filter((item) => {
    if (item?.action !== ACTIONS.BUY) return true;
    if (keepBuySet.has(item.symbol)) {
      kept.push(item.symbol);
      keepBuySet.delete(item.symbol);
      return true;
    }
    dropped.push(item.symbol);
    return false;
  });

  return {
    decision: {
      ...portfolioDecision,
      decisions: nextDecisions,
    },
    reduction: {
      currentLongCount,
      maxSameDirection,
      remainingLongSlots,
      requestedBuyCount: buyDecisions.length,
      kept,
      dropped,
    },
  };
}

export function buildExitEntryBridgeSummary(exitResults = []) {
  const executed = exitResults.filter(isActuallyExecuted).filter(item => item?.action === ACTIONS.SELL);
  const closedPositions = executed.map((item) => {
    const trade = item.execution?.trade || item.execution?.execution?.trade || item.trade || null;
    const reclaimedUsdt = Number(trade?.total_usdt ?? trade?.totalUsdt ?? 0);
    return {
      symbol: item.symbol,
      reason: item.reasoning || 'EXIT Phase 청산',
      reclaimedUsdt,
    };
  });
  const reclaimedUsdt = closedPositions.reduce((sum, item) => sum + Number(item.reclaimedUsdt || 0), 0);
  return {
    closedCount: closedPositions.length,
    reclaimedUsdt,
    closedPositions,
  };
}

export function buildPlannerRunMeta(plannerCompact = null) {
  if (!plannerCompact) return {};
  return {
    planner_market: plannerCompact.market || 'unknown',
    planner_time_mode: plannerCompact.timeMode || 'unknown',
    planner_trade_mode: plannerCompact.tradeMode || 'normal',
    planner_mode: plannerCompact.mode || 'unknown',
    planner_should_analyze: Boolean(plannerCompact.shouldAnalyze),
    planner_research_depth: Number(plannerCompact.researchDepth || 0),
    planner_skip_reason: plannerCompact.skipReason || null,
    planner_research_only: Boolean(plannerCompact.researchOnly),
    planner_symbol_count: Number(plannerCompact.symbolCount || 0),
  };
}

export function classifyWeakSignalReason(confidence, minConfidence) {
  const gap = Number(minConfidence || 0) - Number(confidence || 0);
  if (gap <= 0.05) return 'confidence_near_threshold';
  if (gap <= 0.12) return 'confidence_mid_gap';
  return 'confidence_far_below_threshold';
}

export function isMidGapPromotionCandidate({ exchange, investmentTradeMode, decision, weakReason }) {
  return exchange === 'binance'
    && (investmentTradeMode === 'validation' || investmentTradeMode === 'normal')
    && (weakReason === 'confidence_mid_gap' || weakReason === 'confidence_near_threshold')
    && decision?.action === ACTIONS.BUY;
}

export function buildMidGapPromotedAmount(amountUsdt, exchange) {
  const numeric = Number(amountUsdt || (exchange === 'binance' ? 100 : 500));
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return exchange === 'binance' ? 50 : 500;
  }
  if (exchange === 'binance') {
    return Math.max(50, Math.round(numeric * 0.7));
  }
  return numeric;
}

export function mergeUniqueSymbols(primary = [], fallback = []) {
  const out = [];
  const seen = new Set();
  for (const item of [...primary, ...fallback]) {
    const value = String(item || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

export function applyDiscoveryHardCap(symbols = [], maxSymbols = 60) {
  if (!Array.isArray(symbols)) return [];
  const cap = Math.max(1, Number(maxSymbols || 60));
  return symbols.length > cap ? symbols.slice(0, cap) : symbols;
}

export function clamp01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export function normalizeRegimeLabel(regime = null) {
  const raw = String(regime?.regime || regime?.label || regime || '').trim();
  return raw || 'ranging';
}
