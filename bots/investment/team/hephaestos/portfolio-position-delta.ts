// @ts-nocheck

import { extractExecutionTimestampMs } from '../../shared/binance-order-execution-normalizer.ts';
/**
 * Portfolio/position delta helpers for Hephaestos.
 *
 * The execution bot still coordinates signal flow; this module owns the local
 * position/journal mutations caused by fills and wallet reconciliation.
 */

export function createPortfolioPositionDelta(context = {}) {
  const {
    ACTIONS,
    SIGNAL_STATUS,
    db,
    journalDb,
    getInvestmentTradeMode,
    fetchAssetBalances,
    marketSell,
    buildDeterministicClientOrderId,
    normalizePartialExitRatio,
    isEffectivePartialExit,
    syncCryptoStrategyExecutionState,
    tryConvertResidualDustToUsdt,
  } = context;

  async function cleanupDustLivePosition(symbol, position, tradeMode, meta = {}) {
    if (!position) return;
    await db.deletePosition(symbol, {
      exchange: position.exchange || 'binance',
      paper: false,
      tradeMode,
    });
    console.log(`  ⚠️ ${symbol} 실잔고 최소수량 미달 → DB 포지션 삭제 정리`);
    if (meta.signalId) {
      await db.updateSignalBlock(meta.signalId, {
        reason: `dust_position_cleaned:${meta.roundedAmount || 0}:${meta.minSellAmount || 0}`,
        code: 'dust_position_cleaned',
        meta: {
          exchange: position.exchange || 'binance',
          symbol,
          dbAmount: Number(position.amount || 0),
          freeBalance: Number(meta.freeBalance || 0),
          roundedAmount: Number(meta.roundedAmount || 0),
          minSellAmount: Number(meta.minSellAmount || 0),
        },
      }).catch(() => {});
    }
  }

  async function reconcileOpenJournalToTrackedAmount(symbol, isPaper, trackedAmount, tradeMode = null) {
    const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
    const openEntries = await journalDb.getOpenJournalEntries('crypto');
    const entry = openEntries.find((e) =>
      e.symbol === symbol
        && Boolean(e.is_paper) === Boolean(isPaper)
        && (e.trade_mode || 'normal') === effectiveTradeMode
    );
    if (!entry) return null;

    const entrySize = Number(entry.entry_size || 0);
    const nextSize = Math.max(0, Number(trackedAmount || 0));
    if (!(entrySize > 0) || !(nextSize > 0) || nextSize >= entrySize) return null;

    const entryValue = Number(entry.entry_value || 0);
    const nextEntryValue = entrySize > 0
      ? entryValue * (nextSize / entrySize)
      : entryValue;

    await db.run(
      `UPDATE trade_journal
       SET entry_size = $1,
           entry_value = $2
       WHERE trade_id = $3`,
      [nextSize, nextEntryValue, entry.trade_id],
    );

    return {
      tradeId: entry.trade_id,
      fromSize: entrySize,
      toSize: nextSize,
      fromEntryValue: entryValue,
      toEntryValue: nextEntryValue,
    };
  }

  async function persistBuyPosition({ symbol, order, effectivePaperMode, signalTradeMode }) {
    let managedAmount = Number(order.filled || 0);
    let managedAvgPrice = Number(order.price || 0);

    if (!effectivePaperMode) {
      try {
        const [walletBalances, liveLegRows] = await Promise.all([
          fetchAssetBalances(symbol).catch(() => null),
          db.query(
            `SELECT amount, avg_price, COALESCE(trade_mode, 'normal') AS trade_mode
               FROM investment.positions
              WHERE exchange = 'binance'
                AND paper = false
                AND symbol = $1
                AND amount > 0`,
            [symbol],
          ).catch(() => []),
        ]);

        const walletTotal = Number(walletBalances?.totalBalance || 0);
        const trackedAmount = liveLegRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
        const trackedValue = liveLegRows.reduce((sum, row) => sum + (Number(row.amount || 0) * Number(row.avg_price || 0)), 0);

        const baselineManagedAmount = trackedAmount + Number(order.filled || 0);
        const residualDustAmount = Math.max(0, walletTotal - baselineManagedAmount);
        managedAmount = Math.max(baselineManagedAmount, walletTotal, Number(order.filled || 0));

        if (managedAmount > 0) {
          const weightedValue = trackedValue + (Number(order.filled || 0) * Number(order.price || 0)) + (residualDustAmount * Number(order.price || 0));
          managedAvgPrice = weightedValue > 0 ? (weightedValue / managedAmount) : Number(order.price || 0);
        }

        if (residualDustAmount > 0.0000001) {
          console.log(`  🧹 ${symbol} 신규 관리 포지션에 dust ${residualDustAmount.toFixed(8)} 추가 흡수`);
        }
      } catch (error) {
        console.warn(`  ⚠️ ${symbol} dust 흡수형 포지션 저장 보정 실패: ${error.message}`);
      }
    }

    await db.upsertPosition({
      symbol,
      amount: managedAmount,
      avgPrice: managedAvgPrice,
      unrealizedPnl: 0,
      paper: effectivePaperMode,
      exchange: 'binance',
      tradeMode: signalTradeMode,
    });
  }

  async function executeSellTrade({
    signalId,
    symbol,
    amount,
    sellPaperMode,
    effectivePositionTradeMode,
    position,
    sourcePositionAmount,
    partialExitRatio = null,
    qualityContext = null,
  }) {
    const sellSubmittedAtMs = Date.now();
    const sellClientOrderId = !sellPaperMode
      ? buildDeterministicClientOrderId({
          signalId,
          symbol,
          action: ACTIONS.SELL,
          scope: effectivePositionTradeMode || 'main',
        })
      : null;
    const order = await marketSell(symbol, amount, sellPaperMode, {
      clientOrderId: sellClientOrderId,
      submittedAtMs: sellSubmittedAtMs,
    });
    const soldAmount = Number(order.filled || order.amount || amount || 0);
    const sellPrice = Number(order.price || order.average || 0);
    const settledUsdt = Number(order.totalUsdt || order.cost || (soldAmount * sellPrice));
    const effectiveRatio = normalizePartialExitRatio(partialExitRatio);
    const baselineAmount = Number(sourcePositionAmount || position?.amount || 0);
    const remainingAmount = Math.max(0, baselineAmount - soldAmount);
    const isPartialExit = isEffectivePartialExit({
      entrySize: baselineAmount,
      soldAmount,
      partialExitRatio: effectiveRatio,
    });
    const trade = {
      signalId,
      symbol,
      side: 'sell',
      amount: soldAmount,
      price: sellPrice,
      totalUsdt: settledUsdt,
      executedAt: extractExecutionTimestampMs(order, sellSubmittedAtMs),
      paper: sellPaperMode,
      exchange: 'binance',
      tradeMode: effectivePositionTradeMode,
      partialExitRatio: isPartialExit
        ? (effectiveRatio < 1
            ? effectiveRatio
            : normalizePartialExitRatio(baselineAmount > 0 ? soldAmount / baselineAmount : 1))
        : null,
      partialExit: isPartialExit,
      remainingAmount: isPartialExit ? remainingAmount : 0,
      ...(qualityContext || {}),
    };

    if (isPartialExit) {
      const remainingUnrealizedPnl = baselineAmount > 0
        ? Number(position?.unrealized_pnl || 0) * (remainingAmount / baselineAmount)
        : 0;
      await db.upsertPosition({
        symbol,
        amount: remainingAmount,
        avgPrice: Number(position?.avg_price || 0),
        unrealizedPnl: remainingUnrealizedPnl,
        paper: sellPaperMode,
        exchange: 'binance',
        tradeMode: effectivePositionTradeMode,
      });
      await syncCryptoStrategyExecutionState({
        symbol,
        tradeMode: effectivePositionTradeMode,
        lifecycleStatus: 'partial_exit_executed',
        recommendation: 'ADJUST',
        reasonCode: 'partial_exit_executed',
        reason: '부분청산 체결 완료',
        trade,
        partialExitRatio: trade.partialExitRatio,
        updatedBy: 'hephaestos_partial_sell',
      });
    } else {
      await db.deletePosition(symbol, {
        exchange: 'binance',
        paper: sellPaperMode,
        tradeMode: effectivePositionTradeMode,
      });

      if (!sellPaperMode) {
        const residual = await fetchAssetBalances(symbol).catch(() => null);
        const residualAmount = Number(residual?.totalBalance || 0);
        if (residualAmount > 0.00000001) {
          const converted = await tryConvertResidualDustToUsdt(symbol, residualAmount).catch(() => null);
          if (converted) {
            console.log(`  🧹 ${symbol} 전량 청산 후 잔여 ${residualAmount.toFixed(8)} 자동 convert → USDT`);
          }
        }
      }
    }

    return trade;
  }

  return {
    cleanupDustLivePosition,
    reconcileOpenJournalToTrackedAmount,
    persistBuyPosition,
    executeSellTrade,
  };
}

export default {
  createPortfolioPositionDelta,
};
