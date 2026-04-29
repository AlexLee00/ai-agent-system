// @ts-nocheck

export function createStrategyExecutionStateSync({ db }) {
  async function syncCryptoStrategyExecutionState({
    symbol,
    tradeMode = 'normal',
    lifecycleStatus,
    recommendation = null,
    reasonCode = null,
    reason = null,
    trade = null,
    partialExitRatio = null,
    executionMission = null,
    riskMission = null,
    watchMission = null,
    updatedBy = 'hephaestos_execute',
  } = {}) {
    if (!symbol || !lifecycleStatus) return null;
    const timestamp = new Date().toISOString();
    return db.updatePositionStrategyProfileState(symbol, {
      exchange: 'binance',
      tradeMode,
      strategyState: {
        lifecycleStatus,
        latestRecommendation: recommendation,
        latestReasonCode: reasonCode,
        latestReason: reason,
        latestExecutedAction: trade?.side || null,
        latestExecutionPrice: Number(trade?.price || 0) || null,
        latestExecutionValue: Number(trade?.totalUsdt || 0) || null,
        latestExecutionAmount: Number(trade?.amount || 0) || null,
        latestPartialExitRatio: partialExitRatio,
        latestExecutionMission: executionMission || null,
        latestRiskMission: riskMission || null,
        latestWatchMission: watchMission || null,
        updatedBy,
        updatedAt: timestamp,
      },
      lastEvaluationAt: timestamp,
      lastAttentionAt: timestamp,
    }).catch(() => null);
  }

  return { syncCryptoStrategyExecutionState };
}

export function createBuyProtectiveExitApplier({
  notifyError,
  normalizeProtectiveExitPrices,
  placeBinanceProtectiveExit,
  buildProtectionSnapshot,
  isStopLossOnlyMode,
}) {
  async function applyBuyProtectiveExit({ trade, signal, order, effectivePaperMode, symbol }) {
    const fillPrice = order.price || order.average || 0;
    if (!(fillPrice > 0 && order.filled > 0)) return;

    const hasDynamic = !!(signal.tpPrice && signal.slPrice);
    trade.tpPrice = hasDynamic
      ? parseFloat(signal.tpPrice.toFixed(2))
      : parseFloat((fillPrice * 1.06).toFixed(2));
    trade.slPrice = hasDynamic
      ? parseFloat(signal.slPrice.toFixed(2))
      : parseFloat((fillPrice * 0.97).toFixed(2));
    trade.tpslSource = hasDynamic ? (signal.tpslSource || 'atr') : 'fixed';
    const tpslTag = hasDynamic ? '[동적 TP/SL]' : '[고정 TP/SL]';
    console.log(`  📐 ${tpslTag} TP=${trade.tpPrice} SL=${trade.slPrice} (${trade.tpslSource})`);

    if (effectivePaperMode) return;

    try {
      const normalizedProtection = normalizeProtectiveExitPrices(symbol, fillPrice, trade.tpPrice, trade.slPrice, trade.tpslSource);
      trade.tpPrice = normalizedProtection.tpPrice;
      trade.slPrice = normalizedProtection.slPrice;
      if (normalizedProtection.sourceUsed !== trade.tpslSource) {
        trade.tpslSource = normalizedProtection.sourceUsed;
      }
      const protection = await placeBinanceProtectiveExit(symbol, order.filled, fillPrice, trade.tpPrice, trade.slPrice);
      Object.assign(trade, buildProtectionSnapshot(protection));
      if (protection.ok) {
        console.log(`  🛡️ TP/SL OCO 설정 완료: TP=${trade.tpPrice} SL=${trade.slPrice}`);
      } else if (isStopLossOnlyMode(protection.mode)) {
        console.warn(`  ⚠️ TP/SL OCO 미지원 → SL-only 보호주문 설정: SL=${trade.slPrice}`);
      } else {
        throw new Error(protection.error || 'protective_exit_failed');
      }
    } catch (tpslErr) {
      console.error(`  ⚠️ TP/SL 설정 실패: ${tpslErr.message}`);
      Object.assign(trade, buildProtectionSnapshot(null, tpslErr.message));
      await notifyError(`헤파이스토스 TP/SL 설정 실패 — ${symbol}`, tpslErr);
    }
  }

  return { applyBuyProtectiveExit };
}
