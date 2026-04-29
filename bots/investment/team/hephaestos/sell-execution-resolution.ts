// @ts-nocheck
/**
 * SELL execution context and amount resolution for Hephaestos.
 *
 * This module owns the balance/position interpretation before a sell order is
 * submitted. The caller still executes the order; this keeps the behavior
 * unchanged while making the fragile balance policy testable in isolation.
 */

export function createSellExecutionResolution(context = {}) {
  const {
    db,
    getExchange,
    findAnyLivePosition,
    normalizePartialExitRatio,
    cancelOpenSellOrdersForSymbol,
    fetchAssetBalances,
    buildSellBalancePolicy,
    reconcileOpenJournalToTrackedAmount,
    getMinSellAmount,
    roundSellAmount,
    cleanupDustLivePosition,
  } = context;

  async function resolveSellExecutionContext({
    persistFailure,
    symbol,
    signalTradeMode,
    globalPaperMode,
  }) {
    const livePosition = await db.getLivePosition(symbol, 'binance', signalTradeMode);
    const fallbackLivePosition = !livePosition
      ? await findAnyLivePosition(symbol, 'binance').catch(() => null)
      : null;
    const paperPosition = await db.getPaperPosition(symbol, 'binance', signalTradeMode);

    if (globalPaperMode && livePosition && !paperPosition) {
      const reason = '실포지션 보유 중에는 PAPER SELL로 혼합 청산을 실행할 수 없음';
      console.warn(`  ⚠️ ${reason}`);
      await persistFailure(reason, {
        code: 'position_mode_conflict',
        meta: {
          paperMode: globalPaperMode,
          liveAmount: livePosition.amount || 0,
          tradeMode: signalTradeMode,
        },
      });
      return { success: false, reason };
    }

    if (!globalPaperMode && !livePosition && fallbackLivePosition && fallbackLivePosition.trade_mode !== signalTradeMode) {
      const reason = `동일 심볼의 다른 trade_mode(${fallbackLivePosition.trade_mode}) LIVE 포지션만 존재 — ${signalTradeMode} SELL로 교차 청산 차단`;
      console.warn(`  ⚠️ ${symbol} ${reason}`);
      await persistFailure(reason, {
        code: 'cross_trade_mode_sell_blocked',
        meta: {
          requestedTradeMode: signalTradeMode,
          fallbackTradeMode: fallbackLivePosition.trade_mode || 'normal',
          fallbackAmount: Number(fallbackLivePosition.amount || 0),
        },
      });
      return { success: false, reason };
    }

    const position = paperPosition || livePosition || fallbackLivePosition;
    const sellPaperMode = globalPaperMode || (!livePosition && Boolean(paperPosition));
    const effectivePositionTradeMode = (!sellPaperMode && (livePosition || fallbackLivePosition)?.trade_mode)
      || paperPosition?.trade_mode
      || signalTradeMode;
    const base = symbol.split('/')[0];
    const balance = sellPaperMode ? null : await getExchange().fetchBalance();
    const freeBalance = Number(balance?.free?.[base] || 0);
    const totalBalance = Number(balance?.total?.[base] || freeBalance || 0);

    return {
      success: true,
      livePosition,
      fallbackLivePosition,
      paperPosition,
      position,
      sellPaperMode,
      effectivePositionTradeMode,
      base,
      freeBalance,
      totalBalance,
    };
  }

  async function resolveSellAmount({
    persistFailure,
    signalId,
    symbol,
    signalTradeMode,
    sellPaperMode,
    livePosition,
    fallbackLivePosition,
    paperPosition,
    position,
    freeBalance,
    totalBalance,
    partialExitRatio = null,
  }) {
    let freeBalanceNow = Number(freeBalance || 0);
    let totalBalanceNow = Number(totalBalance || freeBalance || 0);
    let amount = position?.amount;
    const normalizedPartialExitRatio = normalizePartialExitRatio(partialExitRatio);

    if (!sellPaperMode && normalizedPartialExitRatio >= 1) {
      const { cancelledCount } = await cancelOpenSellOrdersForSymbol(symbol).catch(() => ({ cancelledCount: 0 }));
      if (cancelledCount > 0) {
        const refreshed = await fetchAssetBalances(symbol).catch(() => null);
        if (refreshed) {
          freeBalanceNow = refreshed.freeBalance;
          totalBalanceNow = refreshed.totalBalance;
        }
      }
    }

    if (!amount || amount <= 0) {
      amount = sellPaperMode
        ? Number(livePosition?.amount || fallbackLivePosition?.amount || paperPosition?.amount || 0)
        : totalBalanceNow;
      if (amount <= 0) {
        console.warn(`  ⚠️ ${symbol} 보유량 없음 (DB+바이낸스 모두 0) — SELL 스킵`);
        await persistFailure('보유량 없음', {
          code: 'missing_position',
          meta: { sellPaperMode },
        });
        return { success: false, reason: '보유량 없음' };
      }
      console.log(`  ℹ️ DB 포지션 없음 → 바이낸스 실잔고 사용: ${amount} ${symbol.split('/')[0]}`);
    } else if (!livePosition && fallbackLivePosition && fallbackLivePosition.trade_mode !== signalTradeMode) {
      console.warn(`  ⚠️ ${symbol} SELL 신호(${signalTradeMode})에 대응되는 live 포지션 없음 → ${fallbackLivePosition.trade_mode} 포지션 기준으로 청산`);
    } else if (!sellPaperMode && freeBalanceNow <= 0 && amount > 0 && totalBalanceNow <= 0) {
      const reason = `가용 잔고 없음 (free=${freeBalanceNow}, total=${totalBalanceNow || 0})`;
      console.warn(`  ⚠️ ${symbol} ${reason} — SELL 스킵`);
      await persistFailure(reason, {
        code: 'no_free_balance_for_sell',
        meta: {
          exchange: 'binance',
          symbol,
          dbAmount: position?.amount || 0,
          freeBalance: freeBalanceNow,
          totalBalance: totalBalanceNow,
          sellPaperMode,
        },
      });
      return { success: false, reason };
    } else if (!sellPaperMode && normalizedPartialExitRatio >= 1 && totalBalanceNow > 0) {
      if (Math.abs(amount - totalBalanceNow) > Math.max(0.000001, totalBalanceNow * 0.001)) {
        console.warn(`  ⚠️ ${symbol} 전량 청산 모드 — 전체 잔고 기준으로 SELL 수량 조정 ${amount} → ${totalBalanceNow}`);
      }
      amount = totalBalanceNow;
    } else if (!sellPaperMode) {
      const balancePolicy = buildSellBalancePolicy({
        sourceAmount: amount,
        freeBalance: freeBalanceNow,
        totalBalance: totalBalanceNow,
        partialExitRatio: normalizedPartialExitRatio,
        sellPaperMode,
      });
      if (balancePolicy.lockedByOpenOrders) {
        const reason = `보호주문 잠금 잔고 감지 (free=${freeBalanceNow}, total=${totalBalanceNow}, intended=${balancePolicy.intendedSellAmount})`;
        console.warn(`  ⚠️ ${symbol} ${reason} — journal 수량 보정 없이 SELL 차단`);
        await persistFailure(reason, {
          code: 'balance_locked_by_protective_orders',
          meta: {
            exchange: 'binance',
            symbol,
            dbAmount: position?.amount || 0,
            intendedSellAmount: balancePolicy.intendedSellAmount,
            freeBalance: freeBalanceNow,
            totalBalance: totalBalanceNow,
            lockedBalance: balancePolicy.lockedBalance,
            partialExitRatio: normalizedPartialExitRatio < 1 ? normalizedPartialExitRatio : null,
          },
        });
        return { success: false, reason };
      }
      if (balancePolicy.truePositionDrift) {
        const trackedAmount = Number(balancePolicy.reconcileTrackedAmount || 0);
        const drift = amount - trackedAmount;
        console.warn(`  ⚠️ ${symbol} DB 포지션(${amount})과 실잔고(total=${totalBalanceNow})가 어긋남 — total 기준으로 SELL 진행`);
        await reconcileOpenJournalToTrackedAmount(
          symbol,
          sellPaperMode,
          trackedAmount,
          position?.trade_mode || fallbackLivePosition?.trade_mode || signalTradeMode,
        ).catch(() => null);
        amount = trackedAmount;
        await db.updateSignalBlock(signalId, {
          reason: `position_reconciled_to_balance:${drift.toFixed(8)}`,
          code: 'position_balance_reconciled',
          meta: {
            exchange: 'binance',
            symbol,
            dbAmount: position?.amount || 0,
            freeBalance: freeBalanceNow,
            totalBalance: totalBalanceNow,
            drift,
            driftSource: 'total_balance',
          },
        }).catch(() => {});
      }
    }

    const sourcePositionAmount = Number(amount || 0);
    if (normalizedPartialExitRatio < 1) {
      amount = sourcePositionAmount * normalizedPartialExitRatio;
    }

    if (!sellPaperMode) {
      const minSellAmount = await getMinSellAmount(symbol).catch(() => 0);
      const roundedAmount = roundSellAmount(symbol, amount);
      if (roundedAmount <= 0 || (minSellAmount > 0 && roundedAmount < minSellAmount)) {
        const reason = `최소 매도 수량 미달 (${roundedAmount || amount} < ${minSellAmount || 'exchange_min'})`;
        console.warn(`  ⚠️ ${symbol} ${reason} — SELL 스킵`);
        if (normalizedPartialExitRatio >= 1) {
          await cleanupDustLivePosition(symbol, livePosition, signalTradeMode, {
            signalId,
            freeBalance: freeBalanceNow,
            roundedAmount: roundedAmount || amount,
            minSellAmount,
          });
        }
        await persistFailure(reason, {
          code: normalizedPartialExitRatio < 1 ? 'partial_sell_below_minimum' : 'sell_amount_below_minimum',
          meta: {
            requestedAmount: amount,
            roundedAmount,
            minSellAmount,
            sellPaperMode,
            freeBalance: freeBalanceNow,
            totalBalance: totalBalanceNow,
            partialExitRatio: normalizedPartialExitRatio < 1 ? normalizedPartialExitRatio : null,
          },
        });
        return { success: false, reason };
      }
      amount = roundedAmount;
    }

    return {
      success: true,
      amount,
      sourcePositionAmount,
      partialExitRatio: normalizedPartialExitRatio,
      freeBalance: freeBalanceNow,
      totalBalance: totalBalanceNow,
    };
  }

  return {
    resolveSellExecutionContext,
    resolveSellAmount,
  };
}
