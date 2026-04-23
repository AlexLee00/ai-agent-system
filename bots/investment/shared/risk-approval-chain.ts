// @ts-nocheck

import { ACTIONS } from './signal.ts';

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function safeAmount(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function normalizeAction(action = ACTIONS.HOLD) {
  const upper = String(action || ACTIONS.HOLD).toUpperCase();
  if (upper === ACTIONS.BUY || upper === ACTIONS.SELL) return upper;
  return ACTIONS.HOLD;
}

function normalizeRegime(regime = null) {
  const value = String(regime?.regime || regime || 'unknown').toLowerCase();
  if (value.includes('bull')) return 'trending_bull';
  if (value.includes('bear')) return 'trending_bear';
  if (value.includes('rang')) return 'ranging';
  if (value.includes('volatile') || value.includes('extreme')) return 'volatile';
  return value || 'unknown';
}

function parseAnalystSignals(value = '') {
  if (Array.isArray(value)) return value;
  return String(value || '')
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [agent, signal] = part.split(':');
      return { agent: agent || 'unknown', signal: signal || 'N' };
    });
}

export function buildRiskApprovalTarget({
  signal = {},
  portfolio = {},
  marketRegime = null,
  strategyProfile = null,
  strategyRoute = null,
  feedback = null,
  rules = {},
  context = {},
} = {}) {
  const desiredAmount = safeAmount(signal.amount_usdt ?? signal.amountUsdt, 0);
  const totalAsset = safeAmount(portfolio.totalAsset ?? portfolio.total_usdt ?? context.totalUsdt, 0);
  return {
    symbol: signal.symbol,
    action: normalizeAction(signal.action),
    exchange: signal.exchange || context.exchange || 'binance',
    tradeMode: signal.trade_mode || signal.tradeMode || context.tradeMode || 'normal',
    desiredAmount,
    currentAmount: desiredAmount,
    confidence: clamp(signal.confidence ?? 0, 0, 1),
    reasoning: signal.reasoning || '',
    analystSignals: parseAnalystSignals(signal.analyst_signals || signal.analystSignals || ''),
    portfolio: {
      totalAsset,
      positionCount: Number(portfolio.positionCount ?? portfolio.position_count ?? 0),
      todayPnl: Number(portfolio.todayPnl ?? portfolio.today_pnl ?? 0),
    },
    marketRegime: {
      regime: normalizeRegime(marketRegime),
      raw: marketRegime || null,
    },
    strategyRoute: strategyRoute || signal.strategy_route || signal.strategyRoute || null,
    strategyProfile,
    feedback,
    rules,
    context,
  };
}

function appendStep(result, step) {
  return {
    ...result,
    steps: [
      ...(result.steps || []),
      {
        ...step,
        amountBefore: Number(step.amountBefore ?? result.adjustedAmount ?? 0),
        amountAfter: Number(step.amountAfter ?? result.adjustedAmount ?? 0),
      },
    ],
  };
}

function setAmount(result, amount) {
  const minOrder = Number(result.target?.rules?.MIN_ORDER_USDT || result.target?.rules?.minOrderUsdt || 0);
  const rounded = Math.floor(Number(amount || 0));
  return {
    ...result,
    adjustedAmount: minOrder > 0 ? Math.max(minOrder, rounded) : rounded,
    decision: result.decision === 'REJECT' ? 'REJECT' : 'ADJUST',
  };
}

export function hardRuleRiskModel(result) {
  const target = result.target;
  if (target.action !== ACTIONS.BUY) {
    return appendStep(result, {
      model: 'hard_rule',
      decision: 'PASS',
      reason: 'BUY가 아니므로 진입 하드룰 생략',
    });
  }
  const rules = target.rules || {};
  const amount = Number(result.adjustedAmount || 0);
  const totalAsset = Number(target.portfolio.totalAsset || 0);
  const minOrder = Number(rules.MIN_ORDER_USDT || rules.minOrderUsdt || 0);
  const maxOrder = Number(rules.MAX_ORDER_USDT || rules.maxOrderUsdt || Infinity);
  const maxPct = Number(rules.MAX_SINGLE_POSITION_PCT || rules.maxSinglePositionPct || 1);
  const maxPositions = Number(rules.MAX_OPEN_POSITIONS || rules.maxOpenPositions || Infinity);

  if (minOrder > 0 && amount < minOrder) {
    return appendStep({
      ...result,
      approved: false,
      decision: 'REJECT',
      rejectReason: `최소 주문 미달 (${amount} < ${minOrder})`,
    }, {
      model: 'hard_rule',
      decision: 'REJECT',
      reason: `최소 주문 미달 (${amount} < ${minOrder})`,
      amountBefore: amount,
      amountAfter: amount,
    });
  }

  if (Number(target.portfolio.positionCount || 0) >= maxPositions) {
    return appendStep({
      ...result,
      approved: false,
      decision: 'REJECT',
      rejectReason: `최대 포지션 초과 (${target.portfolio.positionCount}/${maxPositions})`,
    }, {
      model: 'hard_rule',
      decision: 'REJECT',
      reason: `최대 포지션 초과 (${target.portfolio.positionCount}/${maxPositions})`,
      amountBefore: amount,
      amountAfter: amount,
    });
  }

  let next = result;
  let nextAmount = amount;
  if (Number.isFinite(maxOrder) && nextAmount > maxOrder) nextAmount = maxOrder;
  if (totalAsset > 0 && maxPct > 0 && nextAmount / totalAsset > maxPct) {
    nextAmount = Math.floor(totalAsset * maxPct);
  }

  if (nextAmount !== amount) {
    next = setAmount(next, nextAmount);
    return appendStep(next, {
      model: 'hard_rule',
      decision: 'ADJUST',
      reason: '최대 주문/단일 포지션 한도에 맞춰 감산',
      amountBefore: amount,
      amountAfter: next.adjustedAmount,
    });
  }

  return appendStep(result, {
    model: 'hard_rule',
    decision: 'PASS',
    reason: '진입 하드룰 통과',
    amountBefore: amount,
    amountAfter: amount,
  });
}

export function regimeRiskModel(result) {
  const target = result.target;
  if (!result.approved || target.action !== ACTIONS.BUY) return result;
  const regime = normalizeRegime(target.marketRegime?.regime);
  const multipliers = {
    trending_bull: 1.08,
    ranging: 0.9,
    trending_bear: 0.55,
    volatile: 0.35,
  };
  const multiplier = multipliers[regime] ?? 1;
  const before = Number(result.adjustedAmount || 0);
  const after = Math.floor(before * multiplier);
  if (multiplier === 1 || after === before) {
    return appendStep(result, {
      model: 'regime_risk',
      decision: 'PASS',
      reason: `regime ${regime} 기준 추가 조정 없음`,
      amountBefore: before,
      amountAfter: before,
    });
  }
  const next = setAmount(result, after);
  return appendStep(next, {
    model: 'regime_risk',
    decision: 'ADJUST',
    reason: `regime ${regime} multiplier x${multiplier}`,
    amountBefore: before,
    amountAfter: next.adjustedAmount,
  });
}

export function consensusRiskModel(result) {
  const target = result.target;
  if (!result.approved || target.action !== ACTIONS.BUY) return result;
  const votes = target.analystSignals || [];
  const buy = votes.filter((vote) => String(vote.signal || '').toUpperCase().startsWith('B')).length;
  const sell = votes.filter((vote) => String(vote.signal || '').toUpperCase().startsWith('S')).length;
  const total = Math.max(1, votes.length);
  const consensusScore = (buy - sell) / total;
  const before = Number(result.adjustedAmount || 0);

  if (sell >= 2 && target.confidence < 0.65) {
    return appendStep({
      ...result,
      approved: false,
      decision: 'REJECT',
      rejectReason: `에이전트 반대 합의 강함 (sell ${sell}/${total})`,
    }, {
      model: 'consensus_risk',
      decision: 'REJECT',
      reason: `에이전트 반대 합의 강함 (sell ${sell}/${total})`,
      amountBefore: before,
      amountAfter: before,
      metrics: { buy, sell, total, consensusScore },
    });
  }

  const multiplier = consensusScore >= 0.5 ? 1.05 : consensusScore <= 0 ? 0.82 : 1;
  if (multiplier === 1) {
    return appendStep(result, {
      model: 'consensus_risk',
      decision: 'PASS',
      reason: `합의 점수 ${consensusScore.toFixed(2)} 기준 유지`,
      amountBefore: before,
      amountAfter: before,
      metrics: { buy, sell, total, consensusScore },
    });
  }
  const next = setAmount(result, before * multiplier);
  return appendStep(next, {
    model: 'consensus_risk',
    decision: 'ADJUST',
    reason: `합의 점수 ${consensusScore.toFixed(2)} multiplier x${multiplier}`,
    amountBefore: before,
    amountAfter: next.adjustedAmount,
    metrics: { buy, sell, total, consensusScore },
  });
}

export function feedbackRiskModel(result) {
  const target = result.target;
  if (!result.approved || target.action !== ACTIONS.BUY) return result;
  const feedback =
    target.feedback
    || target.strategyProfile?.strategy_context?.familyPerformanceFeedback
    || target.strategyProfile?.strategyContext?.familyPerformanceFeedback
    || null;
  const bias = String(feedback?.bias || '').trim();
  const before = Number(result.adjustedAmount || 0);
  const multipliers = {
    downweight_by_pnl: 0.78,
    downweight_by_win_rate: 0.88,
    upweight_candidate: 1.06,
  };
  const multiplier = multipliers[bias] || 1;
  if (multiplier === 1) {
    return appendStep(result, {
      model: 'feedback_risk',
      decision: 'PASS',
      reason: '전략 피드백 감산/승격 없음',
      amountBefore: before,
      amountAfter: before,
    });
  }
  const next = setAmount(result, before * multiplier);
  return appendStep(next, {
    model: 'feedback_risk',
    decision: 'ADJUST',
    reason: `strategy feedback ${bias} multiplier x${multiplier}`,
    amountBefore: before,
    amountAfter: next.adjustedAmount,
    metrics: feedback,
  });
}

export function executionFreshnessRiskModel(result) {
  const target = result.target;
  const approvedAt = target.context?.approvedAt || target.context?.approved_at || null;
  if (!approvedAt) {
    return appendStep(result, {
      model: 'execution_freshness',
      decision: 'PASS',
      reason: '승인 시각 없음, 사전 승인 단계로 간주',
    });
  }
  const ageMs = Date.now() - new Date(approvedAt).getTime();
  if (ageMs > 5 * 60 * 1000) {
    return appendStep({
      ...result,
      approved: false,
      decision: 'REJECT',
      rejectReason: `승인 후 ${Math.round(ageMs / 1000)}초 경과`,
    }, {
      model: 'execution_freshness',
      decision: 'REJECT',
      reason: `승인 후 ${Math.round(ageMs / 1000)}초 경과`,
      amountBefore: result.adjustedAmount,
      amountAfter: result.adjustedAmount,
    });
  }
  return appendStep(result, {
    model: 'execution_freshness',
    decision: 'PASS',
    reason: `승인 freshness ${Math.round(ageMs / 1000)}초`,
    amountBefore: result.adjustedAmount,
    amountAfter: result.adjustedAmount,
  });
}

export const DEFAULT_RISK_MODELS = [
  hardRuleRiskModel,
  regimeRiskModel,
  consensusRiskModel,
  feedbackRiskModel,
  executionFreshnessRiskModel,
];

export function runRiskApprovalChain(target, models = DEFAULT_RISK_MODELS) {
  let result = {
    approved: true,
    decision: 'APPROVE',
    adjustedAmount: Number(target.currentAmount || target.desiredAmount || 0),
    target,
    steps: [],
    rejectReason: null,
  };
  for (const model of models) {
    result = model(result);
    if (!result.approved || result.decision === 'REJECT') break;
  }
  return {
    ...result,
    finalAmount: result.adjustedAmount,
    modelCount: result.steps.length,
  };
}

