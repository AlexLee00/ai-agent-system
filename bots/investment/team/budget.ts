// @ts-nocheck
/**
 * team/budget.js — 네메시스 예산/포지션 관리
 */

import { SIGNAL_STATUS } from '../shared/signal.ts';

export function calcKellyPosition(winRate, rrRatio, mode = 'half') {
  const p = winRate;
  const q = 1 - p;
  const b = rrRatio;
  if (b <= 0 || p <= 0 || p >= 1) return 0.01;
  const kelly = (p * b - q) / b;
  if (kelly <= 0) return 0.01;
  const raw = mode === 'half' ? kelly / 2 : kelly;
  return Math.min(raw, 0.05);
}

export async function calculate(signal, context, deps) {
  const {
    totalUsdt,
    rules,
    traceId,
    persist,
    isStockExchange,
    isCryptoExchange,
    stockThresholds,
    amountUsdt: initialAmount,
  } = context;
  const {
    db,
    calcVolatilityFactor,
    calcCorrelationFactor,
    calcTimeFactor,
    getDynamicRRByRegime,
    getDynamicRRWeighted,
    getDynamicRR,
    calculateDynamicTPSL,
    applyReviewTpslAdjustment,
    calcReviewAdjustment,
    isDynamicTPSLEnabled,
  } = deps;

  let amountUsdt = initialAmount;
  let autoApproval = null;
  const { symbol, action } = signal;

  if (action === 'BUY' && isStockExchange) {
    const autoApproveLimit = signal.exchange === 'kis'
      ? stockThresholds.stockAutoApproveDomestic
      : stockThresholds.stockAutoApproveOverseas;
    if (amountUsdt <= autoApproveLimit) {
      if (persist) {
        if (signal.id) {
          await db.updateSignalStatus(signal.id, SIGNAL_STATUS.APPROVED);
          await db.updateSignalAmount(signal.id, amountUsdt);
        }
        await db.insertRiskLog({
          traceId, symbol, exchange: signal.exchange, decision: 'APPROVE', riskScore: 1,
          reason: `주식 공격적 모드 소규모 자동 승인 (${amountUsdt} <= ${autoApproveLimit})`,
        }).catch(() => {});
      }
      autoApproval = { approved: true, adjustedAmount: amountUsdt, traceId, autoApproved: true };
    } else {
      const starterApproveLimit = signal.exchange === 'kis'
        ? stockThresholds.stockStarterApproveDomestic
        : stockThresholds.stockStarterApproveOverseas;
      if ((signal.confidence ?? 0) >= stockThresholds.stockStarterApproveConfidence && amountUsdt <= starterApproveLimit) {
        if (persist) {
          if (signal.id) {
            await db.updateSignalStatus(signal.id, SIGNAL_STATUS.APPROVED);
            await db.updateSignalAmount(signal.id, amountUsdt);
          }
          await db.insertRiskLog({
            traceId, symbol, exchange: signal.exchange, decision: 'APPROVE', riskScore: 2,
            reason: `주식 validation starter 승인 (${amountUsdt} <= ${starterApproveLimit}, confidence ${(signal.confidence ?? 0).toFixed(2)})`,
          }).catch(() => {});
        }
        autoApproval = { approved: true, adjustedAmount: amountUsdt, traceId, autoApproved: true, starterApproved: true };
      }
    }
  }

  let volFactor = 1;
  let corrFactor = 1;
  let timeFactor = 1;
  let reviewAdjustment = { adjustedAmount: amountUsdt, factor: 1, notes: [], insight: null };
  let rrData = null;
  let dynamicTPSL = null;

  if (action === 'BUY' && isCryptoExchange) {
    [volFactor, corrFactor] = await Promise.all([
      calcVolatilityFactor(symbol, context.atrRatio),
      calcCorrelationFactor(symbol, signal.exchange),
    ]);
    timeFactor = calcTimeFactor();
    const combinedFact = volFactor * corrFactor * timeFactor;
    if (combinedFact < 1.0) {
      amountUsdt = Math.max(rules.MIN_ORDER_USDT, Math.floor(amountUsdt * combinedFact));
    }

    rrData = await getDynamicRRByRegime(symbol, context.atrRatio);
    if (!rrData) rrData = await getDynamicRRWeighted(symbol);
    if (!rrData) rrData = await getDynamicRR(symbol);

    if (rrData) {
      const kellyPct = calcKellyPosition(parseFloat(rrData.win_rate) / 100, parseFloat(rrData.rr_ratio), 'half');
      const kellyAmount = Math.max(rules.MIN_ORDER_USDT, Math.floor(totalUsdt * kellyPct));
      if (kellyAmount < amountUsdt) amountUsdt = kellyAmount;
    }

    reviewAdjustment = await calcReviewAdjustment(symbol, signal.exchange, amountUsdt);
    if (reviewAdjustment.factor < 1 && reviewAdjustment.adjustedAmount < amountUsdt) {
      amountUsdt = reviewAdjustment.adjustedAmount;
    }

    dynamicTPSL = (rrData && isDynamicTPSLEnabled())
      ? {
          tpPct: rrData.suggested_tp_pct,
          slPct: rrData.suggested_sl_pct,
          tpPrice: context.entryEstimate ? context.entryEstimate * (1 + rrData.suggested_tp_pct) : null,
          slPrice: context.entryEstimate ? context.entryEstimate * (1 - rrData.suggested_sl_pct) : null,
          source: rrData.source,
          applied: true,
        }
      : calculateDynamicTPSL(symbol, context.entryEstimate, context.atrRatio);

    if (reviewAdjustment.insight?.closedTrades >= 3) {
      dynamicTPSL = applyReviewTpslAdjustment(dynamicTPSL, reviewAdjustment.insight, context.entryEstimate);
    }
  }

  return { amountUsdt, autoApproval, volFactor, corrFactor, timeFactor, rrData, reviewAdjustment, dynamicTPSL };
}

