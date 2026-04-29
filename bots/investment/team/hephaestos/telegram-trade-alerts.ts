// @ts-nocheck
/**
 * Trade notification and journal settlement helpers for Hephaestos.
 *
 * Execution stays in the main bot; this module owns the post-fill reporting
 * contract so Telegram/digest and trade-journal changes can be tested in
 * isolation.
 */

export function createTelegramTradeAlerts(context = {}) {
  const {
    SIGNAL_STATUS,
    db,
    journalDb,
    notifySettlement,
    notifyTrade,
    notifyJournalEntry,
    getInvestmentTradeMode,
    normalizePartialExitRatio,
    isEffectivePartialExit,
    getAvailableBalance,
    getOpenPositions,
    getDailyPnL,
    syncPositionsAtMarketOpen,
  } = context;

  async function closeOpenJournalForSymbol(
    symbol,
    isPaper,
    exitPrice,
    exitValue,
    exitReason,
    tradeMode = null,
    {
      executionOrigin = null,
      qualityFlag = null,
      excludeFromLearning = null,
      incidentLink = null,
    } = {},
  ) {
    const openEntries = await journalDb.getOpenJournalEntries('crypto');
    const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
    const entry = openEntries.find(e =>
      e.symbol === symbol
        && Boolean(e.is_paper) === Boolean(isPaper)
        && (e.trade_mode || 'normal') === effectiveTradeMode
    );
    if (!entry) return;

    const pnlAmount = (exitValue || 0) - (entry.entry_value || 0);
    const pnlPercent = entry.entry_value > 0
      ? journalDb.ratioToPercent(pnlAmount / entry.entry_value)
      : null;
    await journalDb.closeJournalEntry(entry.trade_id, {
      exitPrice,
      exitValue,
      exitReason,
      pnlAmount,
      pnlPercent,
      pnlNet: pnlAmount,
      execution_origin: executionOrigin,
      quality_flag: qualityFlag,
      exclude_from_learning: excludeFromLearning,
      incident_link: incidentLink,
    });
    await journalDb.ensureAutoReview(entry.trade_id).catch(() => {});
    const review = await journalDb.getReviewByTradeId(entry.trade_id).catch(() => null);
    const weekly = await db.get(`
      SELECT
        COALESCE(SUM(pnl_net), 0) AS pnl,
        COUNT(*) AS total_trades,
        COUNT(*) FILTER (WHERE pnl_net > 0) AS wins
      FROM trade_journal
      WHERE exchange = 'binance'
        AND status = 'closed'
        AND exit_time IS NOT NULL
        AND exit_time >= ?
    `, [Date.now() - 7 * 24 * 60 * 60 * 1000]).catch(() => null);
    const settledAt = Date.now();
    const holdHours = entry.entry_time ? Math.max(0, ((settledAt - Number(entry.entry_time)) / 3600000)) : null;
    await notifySettlement({
      symbol,
      side: 'buy',
      market: 'crypto',
      exchange: 'binance',
      tradeMode: tradeMode || getInvestmentTradeMode(),
      entryPrice: entry.entry_price,
      exitPrice,
      pnl: pnlAmount,
      pnlPercent,
      holdDuration: holdHours != null ? `${holdHours.toFixed(1)}시간` : null,
      weeklyPnl: weekly?.pnl != null ? Number(weekly.pnl) : null,
      totalTrades: weekly?.total_trades != null ? Number(weekly.total_trades) : null,
      wins: weekly?.wins != null ? Number(weekly.wins) : null,
      winRate: weekly?.total_trades ? Number(weekly.wins || 0) / Number(weekly.total_trades) : null,
      paper: isPaper,
      maxFavorable: review?.max_favorable ?? null,
      maxAdverse: review?.max_adverse ?? null,
      signalAccuracy: review?.signal_accuracy ?? null,
      executionSpeed: review?.execution_speed ?? null,
      qualityFlag,
      incidentLink,
    }).catch(() => {});
  }

  async function settleOpenJournalForSell(
    symbol,
    isPaper,
    exitPrice,
    exitValue,
    exitReason,
    tradeMode = null,
    {
      partialExitRatio = null,
      soldAmount = null,
      signalId = null,
      executionOrigin = null,
      qualityFlag = null,
      excludeFromLearning = null,
      incidentLink = null,
    } = {},
  ) {
    const openEntries = await journalDb.getOpenJournalEntries('crypto');
    const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
    const entry = openEntries.find((e) =>
      e.symbol === symbol
        && Boolean(e.is_paper) === Boolean(isPaper)
        && (e.trade_mode || 'normal') === effectiveTradeMode
    );
    if (!entry) return { partial: false, updated: false };

    const normalizedRatio = normalizePartialExitRatio(partialExitRatio);
    const entrySize = Number(entry.entry_size || 0);
    const entryValue = Number(entry.entry_value || 0);
    const realizedSize = Math.min(entrySize, Math.max(0, Number(soldAmount || 0)));
    const isPartial = isEffectivePartialExit({
      entrySize,
      soldAmount: realizedSize,
      partialExitRatio: normalizedRatio,
    });

    if (!isPartial) {
      await closeOpenJournalForSymbol(symbol, isPaper, exitPrice, exitValue, exitReason, effectiveTradeMode, {
        executionOrigin,
        qualityFlag,
        excludeFromLearning,
        incidentLink,
      });
      return { partial: false, updated: true };
    }

    const realizedEntryValue = entrySize > 0
      ? entryValue * (realizedSize / entrySize)
      : 0;
    const pnlAmount = (exitValue || 0) - realizedEntryValue;
    const pnlPercent = realizedEntryValue > 0
      ? journalDb.ratioToPercent(pnlAmount / realizedEntryValue)
      : null;
    const remainingSize = Math.max(0, entrySize - realizedSize);
    const remainingEntryValue = Math.max(0, entryValue - realizedEntryValue);
    const partialTradeId = await journalDb.generateTradeId();

    await journalDb.insertJournalEntry({
      trade_id: partialTradeId,
      signal_id: signalId ?? entry.signal_id ?? null,
      market: entry.market,
      exchange: entry.exchange,
      symbol: entry.symbol,
      is_paper: entry.is_paper,
      trade_mode: entry.trade_mode,
      entry_time: entry.entry_time,
      entry_price: entry.entry_price,
      entry_size: realizedSize,
      entry_value: realizedEntryValue,
      direction: entry.direction || 'long',
      signal_time: entry.signal_time ?? null,
      decision_time: entry.decision_time ?? null,
      execution_time: Date.now(),
      signal_to_exec_ms: entry.signal_to_exec_ms ?? null,
      tp_price: entry.tp_price ?? null,
      sl_price: entry.sl_price ?? null,
      tp_order_id: entry.tp_order_id ?? null,
      sl_order_id: entry.sl_order_id ?? null,
      tp_sl_set: entry.tp_sl_set ?? false,
      tp_sl_mode: entry.tp_sl_mode ?? null,
      tp_sl_error: entry.tp_sl_error ?? null,
      market_regime: entry.market_regime ?? null,
      market_regime_confidence: entry.market_regime_confidence ?? null,
      strategy_family: entry.strategy_family ?? null,
      strategy_quality: entry.strategy_quality ?? null,
      strategy_readiness: entry.strategy_readiness ?? null,
      strategy_route: entry.strategy_route ?? null,
      execution_origin: executionOrigin || entry.execution_origin || 'strategy',
      quality_flag: qualityFlag || entry.quality_flag || 'trusted',
      exclude_from_learning: Boolean(excludeFromLearning ?? entry.exclude_from_learning ?? false),
      incident_link: incidentLink || entry.incident_link || null,
    });

    await journalDb.closeJournalEntry(partialTradeId, {
      exitPrice,
      exitValue,
      exitReason,
      pnlAmount,
      pnlPercent,
      pnlNet: pnlAmount,
      execution_origin: executionOrigin,
      quality_flag: qualityFlag,
      exclude_from_learning: excludeFromLearning,
      incident_link: incidentLink,
    });

    await db.run(
      `UPDATE trade_journal
       SET entry_size = $1,
           entry_value = $2
       WHERE trade_id = $3`,
      [remainingSize, remainingEntryValue, entry.trade_id],
    );

    await journalDb.ensureAutoReview(partialTradeId).catch(() => {});
    return {
      partial: true,
      updated: true,
      realizedTradeId: partialTradeId,
      remainingSize,
      remainingEntryValue,
    };
  }

  async function notifyExecutedTrade({ trade, signalTradeMode, capitalPolicy }) {
    const [curBalance, curPositions, curDailyPnl] = await Promise.all([
      getAvailableBalance().catch(() => null),
      getOpenPositions('binance', false, signalTradeMode).catch(() => []),
      getDailyPnL(trade.exchange || 'binance', signalTradeMode).catch(() => null),
    ]);

    await notifyTrade({
      ...trade,
      tradeMode: signalTradeMode,
      capitalInfo: {
        balance: curBalance,
        openPositions: curPositions.length,
        maxPositions: capitalPolicy.max_concurrent_positions,
        dailyPnL: curDailyPnl,
      },
    });
  }

  async function recordExecutedTradeJournal({ trade, signalId, exitReason }) {
    if (trade.side === 'buy') {
      const execTime = Date.now();
      const tradeId = await journalDb.generateTradeId();
      const signal = signalId ? await db.getSignalById(signalId).catch(() => null) : null;
      const executionOrigin = trade.executionOrigin || 'strategy';
      const excludeFromLearning = Boolean(trade.excludeFromLearning ?? false);
      await journalDb.insertJournalEntry({
        trade_id: tradeId,
        signal_id: signalId,
        market: 'crypto',
        exchange: trade.exchange,
        symbol: trade.symbol,
        is_paper: trade.paper,
        entry_time: execTime,
        entry_price: trade.price || 0,
        entry_size: trade.amount || 0,
        entry_value: trade.totalUsdt || 0,
        direction: 'long',
        tp_price: trade.tpPrice ?? null,
        sl_price: trade.slPrice ?? null,
        tp_order_id: trade.tpOrderId ?? null,
        sl_order_id: trade.slOrderId ?? null,
        tp_sl_set: trade.tpSlSet ?? false,
        tp_sl_mode: trade.tpSlMode ?? null,
        tp_sl_error: trade.tpSlError ?? null,
        strategy_family: signal?.strategy_family || null,
        strategy_quality: signal?.strategy_quality || null,
        strategy_readiness: signal?.strategy_readiness ?? null,
        strategy_route: signal?.strategy_route || null,
        execution_origin: executionOrigin,
        quality_flag: trade.qualityFlag || 'trusted',
        exclude_from_learning: excludeFromLearning,
        incident_link: trade.incidentLink || null,
      });
      await journalDb.linkRationaleToTrade(tradeId, signalId);
      const suppressUserFacingAlert = excludeFromLearning
        && ['reconciliation', 'cleanup'].includes(String(executionOrigin || '').toLowerCase());
      if (!suppressUserFacingAlert) {
        notifyJournalEntry({
          tradeId,
          symbol: trade.symbol,
          direction: 'long',
          market: 'crypto',
          entryPrice: trade.price,
          entryValue: trade.totalUsdt,
          isPaper: trade.paper,
          tpPrice: trade.tpPrice,
          slPrice: trade.slPrice,
          tpSlSet: trade.tpSlSet,
        });
      }
      return;
    }

    if (trade.side === 'sell') {
      await settleOpenJournalForSell(
        trade.symbol,
        trade.paper,
        trade.price,
        trade.totalUsdt,
        exitReason || 'signal_reverse',
        trade.tradeMode,
        {
          partialExitRatio: trade.partialExitRatio,
          soldAmount: trade.amount,
          signalId,
          executionOrigin: trade.executionOrigin || 'strategy',
          qualityFlag: trade.qualityFlag || 'trusted',
          excludeFromLearning: Boolean(trade.excludeFromLearning ?? false),
          incidentLink: trade.incidentLink || null,
        },
      );
    }
  }

  async function finalizeExecutedTrade({
    trade,
    signalId,
    signalTradeMode,
    capitalPolicy,
    exitReason,
    executionMeta = null,
    hephaestosRoleState = null,
  }) {
    await db.insertTrade(trade);
    await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);
    if (executionMeta) {
      await db.updateSignalBlock(signalId, {
        meta: {
          exchange: trade.exchange || 'binance',
          symbol: trade.symbol,
          side: trade.side,
          tradeMode: signalTradeMode,
          executionMeta,
        },
      }).catch(() => {});
    }
    await notifyExecutedTrade({ trade, signalTradeMode, capitalPolicy });

    try {
      await recordExecutedTradeJournal({ trade, signalId, exitReason });
    } catch (journalErr) {
      console.warn(`  ⚠️ 매매일지 기록 실패: ${journalErr.message}`);
    }

    if (
      hephaestosRoleState?.mission === 'full_exit_cleanup'
      && trade?.exchange === 'binance'
      && trade?.paper !== true
      && trade?.side === 'sell'
      && !trade?.partialExit
    ) {
      await syncPositionsAtMarketOpen('crypto').catch(() => null);
    }
  }

  return {
    closeOpenJournalForSymbol,
    settleOpenJournalForSell,
    notifyExecutedTrade,
    recordExecutedTradeJournal,
    finalizeExecutedTrade,
  };
}

export default {
  createTelegramTradeAlerts,
};
