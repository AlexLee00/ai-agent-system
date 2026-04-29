// @ts-nocheck

export function createLivePositionReconcile({
  db,
  getExchange,
  fetchTicker,
  closeOpenJournalForSymbol,
} = {}) {
  async function fetchRecentBrokerExit(symbol, amountHint = 0) {
    try {
      const orders = await getExchange().fetchOrders(symbol, undefined, 20);
      const candidates = (orders || [])
        .filter((order) =>
          order?.side === 'sell'
          && order?.status === 'closed'
          && Number(order?.filled || 0) > 0,
        )
        .sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0));
      if (candidates.length === 0) return null;
      if (!(amountHint > 0)) return candidates[0];
      return candidates.find((order) => {
        const filled = Number(order?.filled || 0);
        return filled > 0 && Math.abs(filled - amountHint) <= Math.max(1e-6, amountHint * 0.02);
      }) || candidates[0];
    } catch {
      return null;
    }
  }

  async function reconcileLivePositionsWithBrokerBalance() {
    const livePositions = await db.getAllPositions('binance', false).catch(() => []);
    if (livePositions.length === 0) return [];

    const wallet = await getExchange().fetchBalance();
    const walletTotals = wallet?.total || {};
    const results = [];

    for (const position of livePositions) {
      const symbol = position.symbol;
      const base = String(symbol || '').split('/')[0];
      const trackedAmount = Number(position.amount || 0);
      const walletAmount = Number(walletTotals?.[base] || 0);
      const drift = walletAmount - trackedAmount;
      const tradeMode = position.trade_mode || 'normal';

      if (walletAmount <= 0.000001) {
        const brokerExit = await fetchRecentBrokerExit(symbol, trackedAmount);
        const exitPrice = Number(brokerExit?.average || brokerExit?.price || 0)
          || await fetchTicker(symbol).catch(() => 0);
        const exitValue = trackedAmount * (exitPrice || 0);
        await db.deletePosition(symbol, {
          exchange: 'binance',
          paper: false,
          tradeMode,
        });
        await closeOpenJournalForSymbol(
          symbol,
          false,
          exitPrice || null,
          exitValue || null,
          'broker_wallet_zero_reconciled',
          tradeMode,
          {
            executionOrigin: 'cleanup',
            qualityFlag: 'exclude_from_learning',
            excludeFromLearning: true,
            incidentLink: 'broker_wallet_zero_reconcile',
          },
        ).catch(() => {});
        console.warn(`  ⚠️ [헤파이스토스] ${symbol} 실지갑 0 → 포지션 자동 정리 (${tradeMode})`);
        results.push({ symbol, tradeMode, action: 'deleted', trackedAmount, walletAmount, drift });
        continue;
      }

      if (Math.abs(drift) > Math.max(0.000001, trackedAmount * 0.001)) {
        await db.upsertPosition({
          symbol,
          amount: walletAmount,
          avgPrice: Number(position.avg_price || 0),
          unrealizedPnl: Number(position.unrealized_pnl || 0),
          paper: false,
          exchange: 'binance',
          tradeMode,
        });
        console.warn(`  ⚠️ [헤파이스토스] ${symbol} 실지갑 기준 수량 보정 ${trackedAmount} → ${walletAmount} (${tradeMode})`);
        results.push({ symbol, tradeMode, action: 'updated', trackedAmount, walletAmount, drift });
      }
    }

    return results;
  }

  return {
    fetchRecentBrokerExit,
    reconcileLivePositionsWithBrokerBalance,
  };
}
