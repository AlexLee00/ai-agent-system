// @ts-nocheck
/**
 * Hephaestos risk/capital gate policy.
 *
 * This module owns BUY preflight mode decisions and order sizing guards while
 * hephaestos.ts keeps orchestration. Dependencies are injected to preserve the
 * existing runtime contract and make policy smoke tests possible.
 */

import { rejectExecution } from './execution-failure.ts';
import { buildGuardTelemetryMeta } from './execution-guards.ts';
import { buildHephaestosExecutionAgentPlan } from './execution-agent-plan.ts';

const KNOWN_EXCHANGE_KEYS = new Set(['binance', 'kis', 'kis_overseas', 'toss']);

export function createRiskAndCapitalGatePolicy(context = {}) {
  const {
    getInvestmentExecutionRuntimeConfig,
    preTradeCheck,
    db,
    notifyTradeSkip,
    getOpenPositions,
    findAnyLivePosition,
    fetchTicker,
    calculatePositionSize,
    getDynamicMinOrderAmount,
    getInvestmentTradeMode,
  } = context;

  function isCapitalShortageReason(reason = '') {
    return String(reason || '').includes('잔고 부족') || String(reason || '').includes('현금 보유 부족');
  }

  function normalizeExchange(exchange = 'binance') {
    return String(exchange || 'binance').trim().toLowerCase() || 'binance';
  }

  function exchangeEnvSuffix(exchange = 'binance') {
    return normalizeExchange(exchange).replace(/[^a-z0-9]+/g, '_').toUpperCase();
  }

  function resolveExchangeAndTradeMode(exchangeOrTradeMode = 'binance', maybeTradeMode = undefined) {
    if (maybeTradeMode !== undefined) {
      return {
        exchange: normalizeExchange(exchangeOrTradeMode),
        signalTradeMode: maybeTradeMode || 'normal',
      };
    }
    const value = String(exchangeOrTradeMode || '').trim().toLowerCase();
    if (!KNOWN_EXCHANGE_KEYS.has(value)) {
      return { exchange: 'binance', signalTradeMode: value || 'normal' };
    }
    return { exchange: normalizeExchange(exchangeOrTradeMode), signalTradeMode: 'normal' };
  }

  function getExchangeSofteningConfig(exchange = 'binance') {
    const execution = getInvestmentExecutionRuntimeConfig();
    return execution?.cryptoGuardSoftening?.byExchange?.[normalizeExchange(exchange)] || {};
  }

  function getNormalToValidationFallbackPolicy(exchange = 'binance') {
    return getExchangeSofteningConfig(exchange)?.tradeModes?.normal?.validationFallback || {};
  }

  function getMaxPositionsOverflowPolicy(exchange = 'binance', signalTradeMode = undefined) {
    const resolved = resolveExchangeAndTradeMode(exchange, signalTradeMode);
    return getExchangeSofteningConfig(resolved.exchange)?.tradeModes?.[resolved.signalTradeMode || 'normal']?.maxPositions || {};
  }

  function getValidationLiveReentrySofteningPolicy(exchange = 'binance') {
    return getExchangeSofteningConfig(exchange)?.tradeModes?.validation?.livePositionReentry || {};
  }

  function classifyValidationFallbackGuard(reason = '') {
    const text = String(reason || '');
    if (text.includes('최대 포지션 도달')) return 'max_positions';
    if (text.includes('일간 매매 한도')) return 'daily_trade_limit';
    if (text.includes('live_fire_daily_notional_limit')) return 'daily_trade_limit';
    return null;
  }

  function getLiveFireMaxTradeUsdt(exchange = 'binance') {
    const exchangeKey = `LUNA_MAX_TRADE_USDT_${exchangeEnvSuffix(exchange)}`;
    const value = Number(process.env[exchangeKey] || process.env.LUNA_MAX_TRADE_USDT || 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  function capLiveFireTradeAmount(amount, effectivePaperMode = false, exchange = 'binance') {
    const numeric = Number(amount || 0);
    const cap = getLiveFireMaxTradeUsdt(exchange);
    if (effectivePaperMode || !(cap > 0) || !(numeric > cap)) {
      return { amount: numeric, capApplied: false, cap };
    }
    return { amount: cap, capApplied: true, cap };
  }

  async function maybeFallbackToValidationLane({
    symbol,
    action,
    amountUsdt,
    reason,
    signalTradeMode,
    exchange = 'binance',
    executionAgentPlan = null,
  }) {
    const normalizedExchange = normalizeExchange(exchange);
    const policy = getNormalToValidationFallbackPolicy(normalizedExchange);
    if (policy?.enabled === false) return null;
    if (executionAgentPlan?.normalToValidationFallbackEnabled === false) return null;

    const guardKind = classifyValidationFallbackGuard(reason);
    const allowedGuardKinds = Array.isArray(policy?.allowedGuardKinds) ? policy.allowedGuardKinds : [];
    if (!guardKind || !allowedGuardKinds.includes(guardKind)) return null;

    const existingLive = await findAnyLivePosition(symbol, normalizedExchange).catch(() => null);
    if (existingLive) return null;

    const reductionMultiplier = Number(policy?.reductionMultiplier || 0);
    if (!(reductionMultiplier > 0 && reductionMultiplier < 1)) return null;

    const reducedAmount = Number(amountUsdt || 0) * reductionMultiplier;
    const validationCheck = await preTradeCheck(symbol, 'BUY', reducedAmount, normalizedExchange, 'validation');
    if (!validationCheck.allowed) return null;

    return {
      effectiveTradeMode: 'validation',
      reducedAmountMultiplier: reductionMultiplier,
      validationCheck,
      originTradeMode: signalTradeMode,
      guardKind,
      action,
    };
  }

  async function resolveBuyExecutionMode({
    persistFailure,
    signalId,
    symbol,
    action,
    amountUsdt,
    signalTradeMode,
    globalPaperMode,
    capitalPolicy,
    agentPlan = null,
    exchange = 'binance',
  }) {
    const normalizedExchange = normalizeExchange(exchange);
    const normalFallbackPolicy = getNormalToValidationFallbackPolicy(normalizedExchange);
    const executionAgentPlan = buildHephaestosExecutionAgentPlan({
      agentPlan,
      enabled: {
        normal_to_validation_fallback: normalFallbackPolicy?.enabled !== false,
      },
    });
    const preTradeAmount = capLiveFireTradeAmount(amountUsdt, globalPaperMode, normalizedExchange).amount;
    const check = await preTradeCheck(symbol, 'BUY', preTradeAmount, normalizedExchange, signalTradeMode);
    if (check.allowed) {
      if (check.softGuardApplied) {
        const guardSummary = (check.softGuards || []).map((guard) => guard.kind).join(', ');
        console.log(`  ⚖️ [가드 완화] ${symbol} ${guardSummary} → 감산 허용 x${Number(check.reducedAmountMultiplier || 1).toFixed(2)}`);
      }
      return {
        effectivePaperMode: globalPaperMode,
        softGuardApplied: Boolean(check.softGuardApplied),
        softGuards: check.softGuards || [],
        reducedAmountMultiplier: Number(check.reducedAmountMultiplier || 1),
      };
    }

    const allowPaperFallback = process.env.LUNA_CAPITAL_ALLOW_PAPER_FALLBACK === 'true';
    if (!globalPaperMode && !check.circuit && isCapitalShortageReason(check.reason || '')) {
      if (allowPaperFallback) {
        console.log(`  📄 [자본관리] 실잔고 부족 → PAPER 폴백 (명시 허용): ${check.reason}`);
        await db.updateSignalBlock(signalId, {
          reason: `paper_fallback:${check.reason}`,
          code: 'paper_fallback',
          meta: { exchange: normalizedExchange, symbol, action, amount: amountUsdt },
        });
        notifyTradeSkip({ symbol, action, reason: `실잔고 부족으로 PAPER 전환: ${check.reason}`, priority: 'low' }).catch(() => {});
        return { effectivePaperMode: true };
      }

      console.log(`  💰 [자본관리] 매수가능금액 부족 → capital_backpressure 처리: ${check.reason}`);
      return rejectExecution({
        persistFailure,
        symbol,
        action,
        reason: check.reason,
        code: 'capital_backpressure',
        meta: buildGuardTelemetryMeta(symbol, action, signalTradeMode, {
          capitalShortage: true,
        }, {
          guardKind: 'cash_constrained',
          pressureSource: 'capital_shortage',
        }),
        notify: 'digest',
      });
    }

    if (!globalPaperMode && signalTradeMode === 'normal') {
      const fallback = await maybeFallbackToValidationLane({
        symbol,
        action,
        amountUsdt,
        reason: check.reason || '',
        signalTradeMode,
        exchange: normalizedExchange,
        executionAgentPlan,
      });
      if (fallback) {
        console.log(
          `  ⚖️ [validation fallback] ${symbol} normal 차단 → validation guarded live 전환 x${fallback.reducedAmountMultiplier.toFixed(2)}`
        );
        return {
          effectivePaperMode: false,
          effectiveTradeMode: 'validation',
          softGuardApplied: true,
          softGuards: [
            {
              kind: 'normal_to_validation_fallback',
              exchange: normalizedExchange,
              tradeMode: 'validation',
              originTradeMode: signalTradeMode,
              reductionMultiplier: fallback.reducedAmountMultiplier,
              originReason: check.reason || '',
            },
            ...(fallback.validationCheck?.softGuards || []),
          ],
          reducedAmountMultiplier: fallback.reducedAmountMultiplier,
        };
      }
    }

    console.log(`  ⛔ [자본관리] 매매 스킵: ${check.reason}`);
    return rejectExecution({
      persistFailure,
      symbol,
      action,
      reason: check.reason,
      code: check.circuit ? 'capital_circuit_breaker' : 'capital_guard_rejected',
      meta: buildGuardTelemetryMeta(symbol, action, signalTradeMode, {
        circuit: Boolean(check.circuit),
        circuitType: check.circuitType ?? null,
        openPositions: !check.circuit ? (await getOpenPositions(normalizedExchange, false, signalTradeMode).catch(() => [])).length : undefined,
        maxPositions: !check.circuit ? capitalPolicy.max_concurrent_positions : undefined,
      }, {
        guardKind: check.circuit ? 'capital_circuit_breaker' : 'capital_guard_rejected',
        pressureSource: check.circuit ? 'circuit_breaker' : 'pre_trade_check',
      }),
      notify: check.circuit ? 'circuit' : 'skip',
    });
  }

  async function resolveBuyOrderAmount({
    persistFailure,
    symbol,
    action,
    amountUsdt,
    signal,
    effectivePaperMode,
    reducedAmountMultiplier = 1,
    softGuards = [],
    exchange = 'binance',
  }) {
    const normalizedExchange = normalizeExchange(exchange);
    const slPrice = signal.slPrice || 0;
    const currentPrice = await fetchTicker(symbol).catch(() => 0);
    const sizing = await calculatePositionSize(symbol, currentPrice, slPrice, normalizedExchange);
    const minOrderUsdt = await getDynamicMinOrderAmount(normalizedExchange, signal?.trade_mode || getInvestmentTradeMode());
    if (sizing.skip && !effectivePaperMode) {
      console.log(`  ⛔ [자본관리] 포지션 크기 부족: ${sizing.reason}`);
      return rejectExecution({
        persistFailure,
        symbol,
        action,
        reason: sizing.reason,
        code: 'position_sizing_rejected',
        meta: {
          currentPrice,
          slPrice,
          capitalPct: sizing.capitalPct ?? null,
          riskPercent: sizing.riskPercent ?? null,
        },
        notify: 'skip',
      });
    }

    const softMultiplier = Number(reducedAmountMultiplier || 1);
    const baseAmount = effectivePaperMode ? amountUsdt : sizing.size;
    const uncappedAmount = softMultiplier > 0 && softMultiplier < 1
      ? baseAmount * softMultiplier
      : baseAmount;
    const capped = capLiveFireTradeAmount(uncappedAmount, effectivePaperMode, normalizedExchange);
    const actualAmount = capped.amount;
    if (!effectivePaperMode && actualAmount < minOrderUsdt) {
      return rejectExecution({
        persistFailure,
        symbol,
        action,
        reason: `감산 후 주문금액 ${actualAmount.toFixed(2)} < 최소 ${minOrderUsdt}`,
        code: 'position_sizing_rejected',
        meta: {
          currentPrice,
          slPrice,
          minOrderUsdt,
          reducedAmountMultiplier: softMultiplier,
          softGuards,
          liveFireMaxTradeUsdt: capped.cap || null,
          liveFireCapApplied: capped.capApplied,
        },
        notify: 'skip',
      });
    }
    if (effectivePaperMode) {
      console.log(`  📄 [PAPER] 시그널 원본 금액으로 가상 포지션 추적: ${actualAmount.toFixed(2)} USDT`);
    } else {
      console.log(`  📐 [자본관리] 포지션 ${actualAmount.toFixed(2)} USDT (자본의 ${sizing.capitalPct}% | 리스크 ${sizing.riskPercent}%)`);
      if (softMultiplier > 0 && softMultiplier < 1) {
        console.log(`  🧪 [개발단계 완화] ${symbol} guard 감산 적용 x${softMultiplier.toFixed(2)} (${softGuards.map((guard) => guard.kind).join(', ')})`);
      }
      if (capped.capApplied) {
        console.log(`  🛡️ [live-fire cap] ${symbol} 주문금액 ${uncappedAmount.toFixed(2)} → ${actualAmount.toFixed(2)} USDT`);
      }
    }

    return { actualAmount, liveFireMaxTradeUsdt: capped.cap || null, liveFireCapApplied: capped.capApplied };
  }

  return {
    isCapitalShortageReason,
    getNormalToValidationFallbackPolicy,
    getMaxPositionsOverflowPolicy,
    getValidationLiveReentrySofteningPolicy,
    classifyValidationFallbackGuard,
    getLiveFireMaxTradeUsdt,
    capLiveFireTradeAmount,
    maybeFallbackToValidationLane,
    resolveBuyExecutionMode,
    resolveBuyOrderAmount,
  };
}

export default {
  createRiskAndCapitalGatePolicy,
};
