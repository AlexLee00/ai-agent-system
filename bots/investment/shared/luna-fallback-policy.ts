// @ts-nocheck

import { ACTIONS } from './signal.ts';
import { isValidationTradeMode } from './secrets.ts';
import { getLunaRuntimeConfig } from './runtime-config.ts';
import { adjustLunaBuyCandidate } from './capital-manager.ts';

const LUNA_RUNTIME = getLunaRuntimeConfig();
const MAX_POS_COUNT = LUNA_RUNTIME.maxPosCount;
const STOCK_ORDER_DEFAULTS = LUNA_RUNTIME.stockOrderDefaults;

export function getStockOrderSpec(exchange) {
  return STOCK_ORDER_DEFAULTS[exchange] || null;
}

export function formatStockAmountRule(exchange) {
  const spec = getStockOrderSpec(exchange);
  if (!spec) return 'amount_usdt 범위 정보 없음';
  const unit = exchange === 'kis' ? 'KRW 주문금액' : 'USD 주문금액';
  return `amount_usdt는 ${unit}이며 ${spec.min}~${spec.max} 범위`;
}

export function normalizeDecisionAmount(exchange, action, amount) {
  const spec = getStockOrderSpec(exchange);
  if (!spec) return amount;
  const fallback = action === ACTIONS.SELL ? spec.sellDefault : spec.buyDefault;
  const numeric = Number.isFinite(Number(amount)) ? Number(amount) : fallback;
  return Math.max(spec.min, Math.min(spec.max, Math.round(numeric)));
}

export function formatLunaDecisionAmount(exchange, amount) {
  const numeric = Number(amount || 0);
  if (!Number.isFinite(numeric)) return 'N/A';
  if (exchange === 'kis') {
    return `${Math.round(numeric).toLocaleString('ko-KR')}원`;
  }
  if (exchange === 'kis_overseas') {
    return `$${numeric.toFixed(2)}`;
  }
  return `${numeric.toFixed(2)} USDT`;
}

export function mapCapitalCheckResultToReasonCode(result = '') {
  const value = String(result || '').toLowerCase();
  if (value === 'blocked_balance_unavailable') return 'buying_power_unavailable';
  if (value === 'blocked_cash') return 'cash_constrained_monitor_only';
  if (value === 'blocked_slots') return 'position_slots_exhausted';
  if (value === 'reduce_only') return 'reducing_only_mode';
  return 'capital_backpressure';
}

export function enrichCapitalCheck(check, capitalSnapshot) {
  if (!check || typeof check !== 'object') return check;
  return {
    ...check,
    reasonCode: mapCapitalCheckResultToReasonCode(check.result),
    remainingSlots: Number(capitalSnapshot?.remainingSlots || 0),
  };
}

export function buildCryptoPortfolioFallback(symbolDecisions, portfolio) {
  const capitalSnapshot = portfolio?.capitalSnapshot ?? null;

  // 자본 상태가 ACTIVE_DISCOVERY가 아니면 fallback BUY 생성 금지
  if (capitalSnapshot && capitalSnapshot.mode !== 'ACTIVE_DISCOVERY') {
    return null;
  }

  const candidates = symbolDecisions
    .filter(dec => dec.action !== ACTIONS.HOLD && (dec.confidence || 0) >= 0.38)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  if (candidates.length === 0) return null;

  const slotsAvailable = Math.max(1, Math.min(3, MAX_POS_COUNT - (portfolio?.positionCount || 0)));
  const usdtFree = portfolio?.usdtFree || 0;
  const minOrder = capitalSnapshot?.minOrderAmount ?? 11;

  // 가용 자금이 최소 주문금액 미만이면 BUY fallback 생성하지 않는다 (빈틈 B 수정)
  if (usdtFree < minOrder) {
    console.log(`  🔒 [루나 fallback] usdtFree=${usdtFree.toFixed(2)} < minOrder=${minOrder} → BUY fallback 생략`);
    return null;
  }

  const portfolioCap = Math.max(minOrder, Math.floor((portfolio?.totalAsset || 0) * 0.12));
  const budgetCap = Math.max(minOrder, Math.floor((usdtFree / Math.max(1, slotsAvailable)) * 0.8));
  const baseAmount = Math.max(minOrder, Math.min(180, Math.min(portfolioCap, budgetCap)));

  // 각 후보에 budget checker 적용
  const decisions = [];
  for (let idx = 0; idx < Math.min(candidates.length, slotsAvailable); idx++) {
    const dec = candidates[idx];
    if (dec.action !== ACTIONS.BUY) {
      decisions.push({
        symbol: dec.symbol,
        action: dec.action,
        amount_usdt: dec.amount_usdt || 100,
        confidence: Math.max(0.40, Math.min(0.72, dec.confidence || 0.4)),
        reasoning: `crypto fallback | ${dec.reasoning || '우세 신호 보존'}`.slice(0, 120),
      });
      continue;
    }
    const desired = baseAmount + (idx === 0 ? 20 : 0);
    if (capitalSnapshot) {
      const check = adjustLunaBuyCandidate(desired, capitalSnapshot);
      const enrichedCheck = enrichCapitalCheck(check, capitalSnapshot);
      if (check.result === 'blocked_cash' || check.result === 'blocked_balance_unavailable' || check.result === 'blocked_slots' || check.result === 'reduce_only') {
        console.log(`  🔒 [루나 fallback] ${dec.symbol} BUY 차단 (${check.result}): ${check.reason}`);
        continue;
      }
      decisions.push({
        symbol: dec.symbol,
        action: ACTIONS.BUY,
        amount_usdt: Math.min(220, check.adjustedAmount),
        confidence: Math.max(0.40, Math.min(0.72, dec.confidence || 0.4)),
        reasoning: `crypto fallback 분산진입 | ${dec.reasoning || '우세 신호 보존'}`.slice(0, 120),
        block_meta: check.result !== 'accepted' ? { capitalCheck: enrichedCheck } : undefined,
      });
    } else {
      decisions.push({
        symbol: dec.symbol,
        action: ACTIONS.BUY,
        amount_usdt: Math.max(minOrder, Math.min(220, desired)),
        confidence: Math.max(0.40, Math.min(0.72, dec.confidence || 0.4)),
        reasoning: `crypto fallback 분산진입 | ${dec.reasoning || '우세 신호 보존'}`.slice(0, 120),
      });
    }
  }

  if (decisions.filter(d => d.action === ACTIONS.BUY).length === 0 && decisions.filter(d => d.action !== ACTIONS.HOLD).length === 0) {
    return null;
  }

  return {
    decisions,
    portfolio_view: 'LLM 포트폴리오 판단 공백 보정 — crypto 분산진입 fallback',
    risk_level: 'MEDIUM',
    source: 'crypto_portfolio_fallback',
  };
}

export function buildStockValidationPortfolioFallback(symbolDecisions, exchange, reason = 'llm_emergency_stop') {
  if (!isValidationTradeMode()) return null;
  const candidates = symbolDecisions
    .filter(dec => dec.action !== ACTIONS.HOLD && (dec.confidence || 0) >= 0.18)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  if (candidates.length === 0) return null;
  const spec = getStockOrderSpec(exchange);
  const starterAmount = normalizeDecisionAmount(exchange, ACTIONS.BUY, spec?.min ?? spec?.buyDefault);
  return {
    decisions: candidates.slice(0, 2).map((dec) => ({
      symbol: dec.symbol,
      action: dec.action,
      amount_usdt: starterAmount,
      confidence: Math.max(0.22, Math.min(0.55, dec.confidence || 0.22)),
      reasoning: `주식 validation 긴급 차단 starter fallback | ${dec.reasoning || '우세 신호 유지'}`.slice(0, 120),
    })),
    portfolio_view: `LLM 긴급 차단 fallback — 주식 validation starter 유지 (${reason})`,
    risk_level: 'MEDIUM',
    source: 'stock_validation_emergency_fallback',
    block_reason: reason,
  };
}

export function buildEmergencyPortfolioFallback(symbolDecisions, portfolio, exchange, reason = 'llm_emergency_stop') {
  if (exchange === 'binance') {
    const cryptoFallback = buildCryptoPortfolioFallback(symbolDecisions, portfolio);
    if (cryptoFallback) {
      return {
        ...cryptoFallback,
        portfolio_view: `LLM 긴급 차단 fallback — crypto 분산진입 유지 (${reason})`,
        source: 'llm_emergency_stop_crypto_fallback',
        block_reason: reason,
      };
    }
  }
  if ((exchange === 'kis' || exchange === 'kis_overseas') && isValidationTradeMode()) {
    const stockFallback = buildStockValidationPortfolioFallback(symbolDecisions, exchange, reason);
    if (stockFallback) return stockFallback;
  }

  return {
    decisions: symbolDecisions.map((dec) => ({
      ...dec,
      action: ACTIONS.HOLD,
      amount_usdt: 0,
      reasoning: `LLM 긴급 차단 보수 fallback | ${dec.reasoning || '신규 진입 보류'}`.slice(0, 120),
    })),
    portfolio_view: `LLM 긴급 차단 fallback — 신규 포지션 보류 (${reason})`,
    risk_level: 'HIGH',
    source: 'llm_emergency_stop_hold_fallback',
    block_reason: reason,
  };
}

export function buildVoteFallbackDecision(analyses, exchange = 'binance', reason = '분석가 투표 기반 fallback') {
  const votes = analyses.filter(a => a.signal !== 'HOLD').map(a => a.signal === 'BUY' ? 1 : -1);
  const avgConf = analyses.reduce((s, a) => s + (a.confidence || 0), 0) / (analyses.length || 1);
  const vote = votes.reduce((a, b) => a + b, 0);
  const isStock = exchange === 'kis' || exchange === 'kis_overseas';
  const stockBuyThreshold = isValidationTradeMode() ? 0.18 : 0.3;
  const action = isStock
    ? (vote >= 0 && avgConf >= stockBuyThreshold ? ACTIONS.BUY : vote < -1 ? ACTIONS.SELL : ACTIONS.HOLD)
    : (vote > 0 ? ACTIONS.BUY : vote < 0 ? ACTIONS.SELL : ACTIONS.HOLD);
  const fallbackAmt = isStock
    ? normalizeDecisionAmount(exchange, action, getStockOrderSpec(exchange)?.buyDefault)
    : 100;
  return { action, amount_usdt: fallbackAmt, confidence: avgConf, reasoning: reason };
}

export function buildEmergencySymbolFallbackDecision(analyses, exchange, fused) {
  if (exchange === 'binance' && !fused.hasConflict) {
    if (fused.recommendation === 'LONG' && fused.averageConfidence >= 0.24 && fused.fusedScore >= 0.12) {
      return {
        action: ACTIONS.BUY,
        amount_usdt: 80,
        confidence: Math.max(0.40, Math.min(0.62, fused.averageConfidence)),
        reasoning: '분석가 합의 기반 긴급 차단 starter BUY',
      };
    }
    if (fused.recommendation === 'SHORT' && fused.averageConfidence >= 0.24 && Math.abs(fused.fusedScore) >= 0.12) {
      return {
        action: ACTIONS.SELL,
        amount_usdt: 80,
        confidence: Math.max(0.38, Math.min(0.58, fused.averageConfidence)),
        reasoning: '분석가 합의 기반 긴급 차단 starter SELL',
      };
    }
  }
  if ((exchange === 'kis' || exchange === 'kis_overseas') && isValidationTradeMode() && !fused.hasConflict) {
    const spec = getStockOrderSpec(exchange);
    const starterAmount = normalizeDecisionAmount(exchange, ACTIONS.BUY, spec?.min ?? spec?.buyDefault);
    if (fused.recommendation === 'LONG' && fused.averageConfidence >= 0.16 && fused.fusedScore >= 0.06) {
      return {
        action: ACTIONS.BUY,
        amount_usdt: starterAmount,
        confidence: Math.max(0.22, Math.min(0.52, fused.averageConfidence)),
        reasoning: '주식 validation 긴급 차단 starter BUY',
      };
    }
  }
  return buildVoteFallbackDecision(analyses, exchange, '분석가 투표 기반 (긴급 차단 fallback)');
}

export default {
  getStockOrderSpec,
  formatStockAmountRule,
  normalizeDecisionAmount,
  formatLunaDecisionAmount,
  mapCapitalCheckResultToReasonCode,
  enrichCapitalCheck,
  buildCryptoPortfolioFallback,
  buildStockValidationPortfolioFallback,
  buildEmergencyPortfolioFallback,
  buildVoteFallbackDecision,
  buildEmergencySymbolFallbackDecision,
};
