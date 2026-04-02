/**
 * team/adaptive-risk.js — 네메시스 적응형 리스크 평가
 */

export function isConfidenceDrivenRejection(reason = '') {
  return /확신도|신뢰도/.test(reason || '');
}

export function buildCryptoStarterAmount(amountUsdt, rules, thresholds) {
  const starter = Math.floor(amountUsdt * (thresholds.cryptoStarterScale ?? 0.60));
  return Math.max(rules.MIN_ORDER_USDT, starter);
}

export async function evaluate(signal, context, deps) {
  const {
    amountUsdt,
    rules,
    persist,
    traceId,
    isCryptoExchange,
    todayPnl,
    positionCount,
    volFactor,
    corrFactor,
    timeFactor,
  } = context;
  const {
    evaluateWithLLM,
    getCryptoRiskThresholds,
    notifyRiskRejection,
    db,
  } = deps;

  const llm = await evaluateWithLLM({
    signal,
    adjustedAmount: amountUsdt,
    volFactor,
    corrFactor,
    timeFactor,
    todayPnl,
    positionCount,
    exchange: signal.exchange,
  });

  let adjustedAmount = amountUsdt;
  const cryptoThresholds = getCryptoRiskThresholds();
  if (
    llm.decision === 'REJECT' &&
    isCryptoExchange &&
    (signal.confidence ?? 0) >= cryptoThresholds.cryptoStarterApproveConfidence &&
    (llm.risk_score ?? 0) <= cryptoThresholds.cryptoStarterApproveMaxRisk &&
    isConfidenceDrivenRejection(llm.reasoning)
  ) {
    adjustedAmount = buildCryptoStarterAmount(adjustedAmount, rules, cryptoThresholds);
    llm.decision = 'ADJUST';
    llm.reasoning = `crypto starter 승인 — 확신도 ${(signal.confidence ?? 0).toFixed(2)} 구간은 소액 분산진입 우선`;
  }

  if (llm.decision === 'REJECT') {
    if (persist && signal.id) await db.updateSignalStatus(signal.id, 'rejected');
    if (persist) await notifyRiskRejection({ symbol: signal.symbol, action: signal.action, reason: `[LLM] ${llm.reasoning}` });
    if (persist) await db.insertRiskLog({ traceId, symbol: signal.symbol, exchange: signal.exchange, decision: 'REJECT', riskScore: llm.risk_score ?? null, reason: llm.reasoning }).catch(() => {});
    return { approved: false, reason: llm.reasoning, llm, adjustedAmount };
  }

  if (llm.decision === 'ADJUST' && llm.adjusted_amount) {
    adjustedAmount = Math.max(rules.MIN_ORDER_USDT, Math.floor(llm.adjusted_amount));
  }

  if (persist) {
    await db.insertRiskLog({ traceId, symbol: signal.symbol, exchange: signal.exchange, decision: llm.decision, riskScore: llm.risk_score ?? null, reason: llm.reasoning }).catch(() => {});
  }

  return { approved: true, adjustedAmount, llm };
}
