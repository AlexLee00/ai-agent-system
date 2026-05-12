// @ts-nocheck
import { selectOpenJournalEntryForSell } from './open-journal-entry-resolver.ts';
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

  function toEpochMs(value, fallback = null) {
    if (value == null || value === '') return fallback;
    const direct = Number(value);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function getJournalDustToleranceUsdt() {
    const configured = Number(process.env.LUNA_JOURNAL_DUST_TOLERANCE_USDT);
    return Number.isFinite(configured) && configured >= 0 ? configured : 1;
  }

  function isDustRemainderAfterSell({ entrySize = 0, entryValue = 0, soldAmount = 0 } = {}) {
    const normalizedEntrySize = Number(entrySize || 0);
    const normalizedEntryValue = Number(entryValue || 0);
    const normalizedSoldAmount = Math.max(0, Number(soldAmount || 0));
    if (!(normalizedEntrySize > 0) || !(normalizedSoldAmount > 0)) return false;
    const remainingSize = Math.max(0, normalizedEntrySize - normalizedSoldAmount);
    if (remainingSize <= 0.00000001) return true;
    const remainingEntryValue = normalizedEntrySize > 0
      ? normalizedEntryValue * (remainingSize / normalizedEntrySize)
      : 0;
    return remainingEntryValue <= getJournalDustToleranceUsdt();
  }

  async function closeResolvedJournalEntry(
    entry,
    {
      symbol,
      isPaper,
      exitPrice,
      exitValue,
      exitReason,
      tradeMode = null,
      exitTime = null,
      executionOrigin = null,
      qualityFlag = null,
      excludeFromLearning = null,
      incidentLink = null,
    } = {},
  ) {
    const pnlAmount = (exitValue || 0) - (entry.entry_value || 0);
    const pnlPercent = entry.entry_value > 0
      ? journalDb.ratioToPercent(pnlAmount / entry.entry_value)
      : null;
    const settledAt = toEpochMs(exitTime, Date.now());
    await journalDb.closeJournalEntry(entry.trade_id, {
      exitTime: settledAt,
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
    const holdHours = entry.entry_time ? Math.max(0, ((settledAt - Number(entry.entry_time)) / 3600000)) : null;
    await notifySettlement({
      symbol,
      side: 'buy',
      market: 'crypto',
      exchange: 'binance',
      tradeMode: entry.trade_mode || tradeMode || getInvestmentTradeMode(),
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
    return { updated: true, tradeId: entry.trade_id };
  }

  async function closeOpenJournalForSymbol(
    symbol,
    isPaper,
    exitPrice,
    exitValue,
    exitReason,
    tradeMode = null,
    {
      exitTime = null,
      executionOrigin = null,
      qualityFlag = null,
      excludeFromLearning = null,
      incidentLink = null,
    } = {},
  ) {
    const openEntries = await journalDb.getOpenJournalEntries('crypto');
    const effectiveTradeMode = tradeMode || getInvestmentTradeMode();
    const selection = selectOpenJournalEntryForSell(openEntries, {
      symbol,
      isPaper,
      tradeMode: effectiveTradeMode,
      allowCrossModeSingleLive: true,
      allowCrossModeAmountMatch: false,
    });
    if (!selection.entry) {
      return { updated: false, reason: selection.reason, candidates: selection.candidates };
    }

    return closeResolvedJournalEntry(selection.entry, {
      symbol,
      isPaper,
      exitPrice,
      exitValue,
      exitReason,
      tradeMode: effectiveTradeMode,
      exitTime,
      executionOrigin,
      qualityFlag,
      excludeFromLearning,
      incidentLink,
    });
  }

  async function settleOpenJournalForSell(
    symbol,
    isPaper,
    exitPrice,
    exitValue,
    exitReason,
    tradeMode = null,
    {
      exitTime = null,
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
    const selection = selectOpenJournalEntryForSell(openEntries, {
      symbol,
      isPaper,
      tradeMode: effectiveTradeMode,
      soldAmount,
      allowCrossModeSingleLive: true,
      allowCrossModeAmountMatch: true,
    });
    const entry = selection.entry;
    if (!entry) {
      return {
        partial: false,
        updated: false,
        reason: selection.reason,
        candidates: selection.candidates,
      };
    }

    const normalizedRatio = normalizePartialExitRatio(partialExitRatio);
    const entrySize = Number(entry.entry_size || 0);
    const entryValue = Number(entry.entry_value || 0);
    const realizedSize = Math.min(entrySize, Math.max(0, Number(soldAmount || 0)));
    const rawPartial = isEffectivePartialExit({
      entrySize,
      soldAmount: realizedSize,
      partialExitRatio: normalizedRatio,
    });
    const isPartial = rawPartial && !isDustRemainderAfterSell({
      entrySize,
      entryValue,
      soldAmount: realizedSize,
    });

    if (!isPartial) {
      await closeResolvedJournalEntry(entry, {
        symbol,
        isPaper,
        exitPrice,
        exitValue,
        exitReason,
        tradeMode: effectiveTradeMode,
        exitTime,
        executionOrigin,
        qualityFlag,
        excludeFromLearning,
        incidentLink,
      });
      return { partial: false, updated: true, tradeId: entry.trade_id, matchType: selection.matchType };
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
      exitTime: toEpochMs(exitTime, Date.now()),
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
      tradeId: entry.trade_id,
      matchType: selection.matchType,
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
      const execTime = toEpochMs(trade.executedAt, Date.now());
      const tradeId = await journalDb.generateTradeId();
      const signal = signalId ? await db.getSignalById(signalId).catch(() => null) : null;
      const executionOrigin = trade.executionOrigin || 'strategy';
      const excludeFromLearning = Boolean(trade.excludeFromLearning ?? false);
      const effectiveTradeMode = trade.tradeMode || trade.trade_mode || signal?.trade_mode || getInvestmentTradeMode();
      await journalDb.insertJournalEntry({
        trade_id: tradeId,
        signal_id: signalId,
        market: 'crypto',
        exchange: trade.exchange,
        symbol: trade.symbol,
        is_paper: trade.paper,
        trade_mode: effectiveTradeMode,
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
      const persisted = await journalDb.getJournalEntryByTradeId(tradeId).catch(() => null);
      if (!persisted) {
        const err = new Error(`journal_insert_missing_after_buy:${trade.symbol}:${effectiveTradeMode}`);
        err.code = 'journal_insert_missing_after_buy';
        err.meta = { tradeId, symbol: trade.symbol, tradeMode: effectiveTradeMode, signalId };
        throw err;
      }
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
      const settlement = await settleOpenJournalForSell(
        trade.symbol,
        trade.paper,
        trade.price,
        trade.totalUsdt,
        exitReason || 'signal_reverse',
        trade.tradeMode,
        {
          exitTime: trade.executedAt || null,
          partialExitRatio: trade.partialExitRatio,
          soldAmount: trade.amount,
          signalId,
          executionOrigin: trade.executionOrigin || 'strategy',
          qualityFlag: trade.qualityFlag || 'trusted',
          excludeFromLearning: Boolean(trade.excludeFromLearning ?? false),
          incidentLink: trade.incidentLink || null,
        },
      );
      if (!settlement?.updated) {
        const err = new Error(`journal_settlement_missing_for_sell:${trade.symbol}:${trade.tradeMode || getInvestmentTradeMode()}`);
        err.code = 'journal_settlement_missing_for_sell';
        err.meta = {
          symbol: trade.symbol,
          tradeMode: trade.tradeMode || getInvestmentTradeMode(),
          signalId,
          reason: settlement?.reason || 'unknown',
          candidates: settlement?.candidates || [],
          soldAmount: trade.amount,
          totalUsdt: trade.totalUsdt,
        };
        throw err;
      }
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
      await db.updateSignalBlock(signalId, {
        reason: String(journalErr.message || 'execution journal write failed').slice(0, 180),
        code: journalErr?.code || 'execution_journal_write_failed',
        meta: {
          exchange: trade.exchange || 'binance',
          symbol: trade.symbol,
          side: trade.side,
          tradeMode: trade.tradeMode || signalTradeMode,
          journalError: String(journalErr.message || journalErr).slice(0, 240),
          ...(journalErr?.meta || {}),
        },
      }).catch(() => {});
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
