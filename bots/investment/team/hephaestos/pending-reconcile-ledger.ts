// @ts-nocheck
/**
 * Pending-reconcile ledger mutations for Hephaestos.
 *
 * This module owns position/trade/journal state changes for Binance pending
 * reconcile. It is dependency-injected to preserve the legacy hephaestos.ts
 * runtime contracts while making the ledger path independently testable.
 */

import {
  BINANCE_PENDING_RECONCILE_EPSILON,
  resolveBinancePendingQueueState,
} from '../../shared/binance-order-reconcile.ts';
import {
  buildPendingReconcileDeltaIncidentLink,
  escapePendingReconcileLikePattern,
  normalizePendingReconcileTradeRow,
} from './pending-reconcile-core.ts';

export function createPendingReconcileLedger(context = {}) {
  const {
    ACTIONS,
    SIGNAL_STATUS,
    db,
    notifyError,
    loadSignalPendingReconcileMeta,
    buildSignalQualityContext,
    normalizePartialExitRatio,
    recordExecutedTradeJournal,
    syncCryptoStrategyExecutionState,
    journalRetryDelayMs = 30_000,
  } = context;

  function buildPendingReconcileQualityContext(signal = null) {
    const base = buildSignalQualityContext(signal);
    return {
      ...base,
      executionOrigin: 'reconciliation',
      qualityFlag: base.qualityFlag === 'exclude_from_learning' ? base.qualityFlag : 'degraded',
      excludeFromLearning: true,
      incidentLink: base.incidentLink || 'order_pending_reconcile',
    };
  }

  async function findPendingReconcileDeltaTrade({
    signalId = null,
    symbol = null,
    side = null,
    incidentLink = null,
  } = {}) {
    if (!signalId || !symbol || !side || !incidentLink) return null;
    return db.get(
      `SELECT id, signal_id, symbol, side, amount, price, total_usdt, paper, exchange, trade_mode, executed_at, incident_link
         FROM trades
        WHERE signal_id = $1
          AND symbol = $2
          AND side = $3
          AND exchange = 'binance'
          AND incident_link = $4
        ORDER BY executed_at DESC
        LIMIT 1`,
      [signalId, symbol, side, incidentLink],
    );
  }

  async function getPendingReconcileAppliedSnapshot({
    signalId = null,
    symbol = null,
    side = null,
    orderId = null,
    clientOrderId = null,
  } = {}) {
    const orderKey = String(orderId || clientOrderId || '').trim();
    if (!signalId || !symbol || !side || !orderKey) {
      return { appliedFilledQty: 0, appliedCost: 0 };
    }
    const prefix = `pending_reconcile_delta:${signalId}:${orderKey}:${String(side).toLowerCase()}:`;
    const likePattern = `${escapePendingReconcileLikePattern(prefix)}%`;
    const row = await db.get(
      `SELECT
         COALESCE(SUM(amount), 0) AS applied_filled_qty,
         COALESCE(SUM(total_usdt), 0) AS applied_cost
       FROM trades
       WHERE signal_id = $1
         AND symbol = $2
         AND side = $3
         AND exchange = 'binance'
         AND incident_link LIKE $4 ESCAPE '\\'`,
      [signalId, symbol, side, likePattern],
    );
    return {
      appliedFilledQty: Math.max(0, Number(row?.applied_filled_qty || 0)),
      appliedCost: Math.max(0, Number(row?.applied_cost || 0)),
    };
  }

  async function loadBinancePendingReconcileTrade({
    signalId = null,
    symbol = null,
    side = null,
    tradeId = null,
    incidentLink = null,
  } = {}) {
    if (!signalId || !symbol || !side) return null;
    if (tradeId) {
      const byId = await db.get(
        `SELECT id, signal_id, symbol, side, amount, price, total_usdt, paper, exchange, trade_mode, incident_link,
                COALESCE(partial_exit, false) AS partial_exit, partial_exit_ratio, remaining_amount,
                execution_origin, quality_flag, exclude_from_learning
           FROM trades
          WHERE id = $1
            AND signal_id = $2
            AND exchange = 'binance'
          LIMIT 1`,
        [tradeId, signalId],
      ).catch(() => null);
      if (byId) return normalizePendingReconcileTradeRow(byId);
    }

    if (incidentLink) {
      const byIncident = await db.get(
        `SELECT id, signal_id, symbol, side, amount, price, total_usdt, paper, exchange, trade_mode, incident_link,
                COALESCE(partial_exit, false) AS partial_exit, partial_exit_ratio, remaining_amount,
                execution_origin, quality_flag, exclude_from_learning
           FROM trades
          WHERE signal_id = $1
            AND symbol = $2
            AND side = $3
            AND exchange = 'binance'
            AND incident_link = $4
          ORDER BY executed_at DESC
          LIMIT 1`,
        [signalId, symbol, side, incidentLink],
      ).catch(() => null);
      if (byIncident) return normalizePendingReconcileTradeRow(byIncident);
    }

    const latest = await db.get(
      `SELECT id, signal_id, symbol, side, amount, price, total_usdt, paper, exchange, trade_mode, incident_link,
              COALESCE(partial_exit, false) AS partial_exit, partial_exit_ratio, remaining_amount,
              execution_origin, quality_flag, exclude_from_learning
         FROM trades
        WHERE signal_id = $1
          AND symbol = $2
          AND side = $3
          AND exchange = 'binance'
        ORDER BY executed_at DESC
        LIMIT 1`,
      [signalId, symbol, side],
    ).catch(() => null);
    return latest ? normalizePendingReconcileTradeRow(latest) : null;
  }

  async function hasPendingReconcileJournalCoverage({
    signalId = null,
    symbol = null,
    incidentLink = null,
  } = {}) {
    if (!signalId || !symbol || !incidentLink) return false;
    const row = await db.get(
      `SELECT trade_id
         FROM trade_journal
        WHERE signal_id = $1
          AND market = 'crypto'
          AND exchange = 'binance'
          AND symbol = $2
          AND incident_link = $3
        ORDER BY created_at DESC
        LIMIT 1`,
      [signalId, symbol, incidentLink],
    );
    return Boolean(row?.trade_id);
  }

  async function markBinancePendingReconcileJournalState(signalId, {
    pendingMeta = {},
    trade = null,
    followUpRequired = false,
    queueStatus = 'completed',
    attemptIncrement = 0,
    lastError = null,
    source = 'pending_reconcile_apply',
  } = {}) {
    if (!signalId) return null;
    const providedPendingMeta = pendingMeta && typeof pendingMeta === 'object' ? pendingMeta : {};
    const currentPendingMeta = await loadSignalPendingReconcileMeta(signalId).catch(() => ({}));
    const basePendingMeta = {
      ...currentPendingMeta,
      ...providedPendingMeta,
    };
    const currentJournalPending = basePendingMeta?.journalPending && typeof basePendingMeta.journalPending === 'object'
      ? basePendingMeta.journalPending
      : {};
    const attemptsBase = Math.max(0, Number(currentJournalPending.attempts || 0));
    const safeAttemptIncrement = Math.max(0, Number(attemptIncrement || 0));
    const attempts = attemptsBase + safeAttemptIncrement;
    const nowIso = new Date().toISOString();
    const journalPendingPatch = {
      exchange: 'binance',
      symbol: trade?.symbol || basePendingMeta?.symbol || null,
      side: trade?.side || null,
      tradeId: trade?.id || currentJournalPending.tradeId || null,
      incidentLink: trade?.incidentLink || currentJournalPending.incidentLink || null,
      queueStatus,
      followUpRequired: Boolean(followUpRequired),
      attempts,
      source,
      nextRetryAt: followUpRequired
        ? new Date(Date.now() + journalRetryDelayMs).toISOString()
        : null,
      lastError: followUpRequired ? String(lastError || 'journal_pending').slice(0, 240) : null,
      updatedAt: nowIso,
    };
    if (!followUpRequired) {
      journalPendingPatch.repairedAt = nowIso;
    }
    const nextPendingReconcile = {
      ...basePendingMeta,
      journalPending: {
        ...currentJournalPending,
        ...journalPendingPatch,
      },
    };
    await db.mergeSignalBlockMeta(signalId, {
      pendingReconcile: nextPendingReconcile,
    });
    return nextPendingReconcile.journalPending;
  }

  async function ensurePendingReconcileJournalRecorded({
    trade = null,
    signalId = null,
    pendingMeta = {},
    source = 'pending_reconcile_apply',
    exitReason = 'order_pending_reconcile_delta',
  } = {}) {
    if (!trade || !signalId) {
      return { ok: false, reason: 'journal_input_missing' };
    }
    const canVerify = Boolean(trade.incidentLink && trade.symbol);
    if (canVerify) {
      const alreadyRecorded = await hasPendingReconcileJournalCoverage({
        signalId,
        symbol: trade.symbol,
        incidentLink: trade.incidentLink,
      });
      if (alreadyRecorded) {
        const pendingState = await markBinancePendingReconcileJournalState(signalId, {
          pendingMeta,
          trade,
          followUpRequired: false,
          queueStatus: 'completed',
          attemptIncrement: 0,
          source,
        }).catch(() => null);
        return {
          ok: true,
          alreadyRecorded: true,
          pendingState,
        };
      }
    }

    let journalError = null;
    try {
      await recordExecutedTradeJournal({
        trade,
        signalId,
        exitReason,
      });
    } catch (error) {
      journalError = error;
    }

    let verified = false;
    if (canVerify) {
      verified = await hasPendingReconcileJournalCoverage({
        signalId,
        symbol: trade.symbol,
        incidentLink: trade.incidentLink,
      }).catch(() => false);
    } else {
      verified = !journalError;
    }

    if (verified) {
      const pendingState = await markBinancePendingReconcileJournalState(signalId, {
        pendingMeta,
        trade,
        followUpRequired: false,
        queueStatus: 'completed',
        attemptIncrement: 1,
        source,
      }).catch(() => null);
      return {
        ok: true,
        alreadyRecorded: false,
        pendingState,
      };
    }

    const reason = journalError
      ? String(journalError?.message || journalError)
      : 'journal_record_unverified';
    const pendingState = await markBinancePendingReconcileJournalState(signalId, {
      pendingMeta,
      trade,
      followUpRequired: true,
      queueStatus: 'queued',
      attemptIncrement: 1,
      lastError: reason,
      source,
    }).catch(() => null);
    return {
      ok: false,
      reason,
      pendingState,
    };
  }

  async function acquirePendingReconcileTxLock(tx, lockKey) {
    const row = await tx.get(
      `SELECT pg_try_advisory_xact_lock(hashtextextended($1, 0)::bigint) AS locked`,
      [String(lockKey || '')],
    );
    if (!row?.locked) {
      const lockError = /** @type {any} */ (new Error(`pending_reconcile_lock_unavailable:${lockKey}`));
      lockError.code = 'pending_reconcile_lock_unavailable';
      throw lockError;
    }
  }

  async function applyBinancePendingReconcileDelta({
    payload,
    deltaFilledQty = 0,
    deltaCost = 0,
    orderPrice = 0,
    stateCode = 'order_pending_reconcile',
  } = {}) {
    if (!payload) return { applied: false, trade: null, tradeModeUsed: null, appliedFilledQty: 0, appliedCost: 0 };
    const normalizedDeltaFilled = Math.max(0, Number(deltaFilledQty || 0));
    if (normalizedDeltaFilled <= BINANCE_PENDING_RECONCILE_EPSILON) {
      return { applied: false, trade: null, tradeModeUsed: payload.tradeMode || 'normal', appliedFilledQty: 0, appliedCost: 0 };
    }

    const normalizedDeltaCost = Math.max(0, Number(deltaCost || 0));
    const normalizedOrderPrice = Math.max(0, Number(orderPrice || 0));
    const unitPrice = normalizedOrderPrice > 0
      ? normalizedOrderPrice
      : (normalizedDeltaCost > 0 ? (normalizedDeltaCost / normalizedDeltaFilled) : 0);
    const totalUsdt = normalizedDeltaCost > 0 ? normalizedDeltaCost : (normalizedDeltaFilled * unitPrice);
    const qualityContext = buildPendingReconcileQualityContext(payload.signal);
    const signalTradeMode = payload.tradeMode || 'normal';
    const targetFilledQty = Math.max(0, Number(payload.recordedFilledQty || 0) + normalizedDeltaFilled);
    const deltaIncidentLink = buildPendingReconcileDeltaIncidentLink({
      signalId: payload.signalId,
      orderId: payload.orderId,
      clientOrderId: payload.clientOrderId,
      action: payload.action,
      targetFilledQty,
    });
    const side = payload.action === ACTIONS.BUY ? 'buy' : 'sell';
    const orderKeyForLock = payload.orderId || payload.clientOrderId || 'none';
    const lockKey = `pending_reconcile_apply:${payload.signalId}:${orderKeyForLock}:${side}`;

    const transactional = await db.withTransaction(async (tx) => {
      await acquirePendingReconcileTxLock(tx, lockKey);

      const existingDeltaTradeRow = await tx.get(
        `SELECT id, signal_id, symbol, side, amount, price, total_usdt, paper, exchange, trade_mode, incident_link,
                NULL::boolean AS partial_exit,
                NULL::double precision AS partial_exit_ratio,
                NULL::double precision AS remaining_amount
           FROM trades
          WHERE signal_id = $1
            AND symbol = $2
            AND side = $3
            AND exchange = 'binance'
            AND incident_link = $4
          ORDER BY executed_at DESC
          LIMIT 1`,
        [payload.signalId, payload.symbol, side, deltaIncidentLink],
      );
      if (existingDeltaTradeRow) {
        const existingTrade = normalizePendingReconcileTradeRow(existingDeltaTradeRow);
        return {
          deduped: true,
          trade: existingTrade,
          tradeModeUsed: existingTrade.tradeMode || signalTradeMode,
        };
      }

      if (payload.action === ACTIONS.BUY) {
        const currentPosition = await tx.get(
          `SELECT symbol, amount, avg_price, unrealized_pnl, paper, exchange, COALESCE(trade_mode, 'normal') AS trade_mode
             FROM positions
            WHERE symbol = $1
              AND exchange = 'binance'
              AND paper = $2
              AND COALESCE(trade_mode, 'normal') = $3
            LIMIT 1
            FOR UPDATE`,
          [payload.symbol, Boolean(payload.paperMode), signalTradeMode],
        );
        const beforeAmount = Math.max(0, Number(currentPosition?.amount || 0));
        const beforeAvgPrice = Math.max(0, Number(currentPosition?.avg_price || 0));
        const nextAmount = beforeAmount + normalizedDeltaFilled;
        const weightedValue = (beforeAmount * beforeAvgPrice) + (normalizedDeltaFilled * unitPrice);
        const nextAvgPrice = nextAmount > BINANCE_PENDING_RECONCILE_EPSILON ? (weightedValue / nextAmount) : unitPrice;

        await tx.run(
          `INSERT INTO positions (symbol, amount, avg_price, unrealized_pnl, paper, exchange, trade_mode, updated_at)
           VALUES ($1, $2, $3, 0, $4, 'binance', $5, now())
           ON CONFLICT (symbol, exchange, paper, trade_mode)
           DO UPDATE SET
             amount = EXCLUDED.amount,
             avg_price = EXCLUDED.avg_price,
             unrealized_pnl = EXCLUDED.unrealized_pnl,
             updated_at = now()`,
          [payload.symbol, nextAmount, nextAvgPrice, Boolean(payload.paperMode), signalTradeMode],
        );

        const insertedTradeRow = await tx.get(
          `INSERT INTO trades
             (signal_id, symbol, side, amount, price, total_usdt, paper, exchange, trade_mode,
              execution_origin, quality_flag, exclude_from_learning, incident_link)
           VALUES
             ($1, $2, 'buy', $3, $4, $5, $6, 'binance', $7, $8, $9, $10, $11)
           RETURNING id, signal_id, symbol, side, amount, price, total_usdt, paper, exchange, trade_mode, incident_link`,
          [
            payload.signalId,
            payload.symbol,
            normalizedDeltaFilled,
            unitPrice,
            totalUsdt,
            Boolean(payload.paperMode),
            signalTradeMode,
            qualityContext.executionOrigin,
            qualityContext.qualityFlag,
            Boolean(qualityContext.excludeFromLearning),
            deltaIncidentLink,
          ],
        );
        const trade = normalizePendingReconcileTradeRow(insertedTradeRow);
        trade.executionOrigin = qualityContext.executionOrigin;
        trade.qualityFlag = qualityContext.qualityFlag;
        trade.excludeFromLearning = Boolean(qualityContext.excludeFromLearning);
        trade.incidentLink = deltaIncidentLink;
        return {
          deduped: false,
          trade,
          tradeModeUsed: signalTradeMode,
        };
      }

      if (payload.action === ACTIONS.SELL) {
        const currentPosition = await tx.get(
          `SELECT symbol, amount, avg_price, unrealized_pnl, paper, exchange, COALESCE(trade_mode, 'normal') AS trade_mode
             FROM positions
            WHERE symbol = $1
              AND exchange = 'binance'
              AND paper = $2
              AND COALESCE(trade_mode, 'normal') = $3
            LIMIT 1
            FOR UPDATE`,
          [payload.symbol, Boolean(payload.paperMode), signalTradeMode],
        );
        const effectiveTradeMode = currentPosition?.trade_mode || signalTradeMode;
        const beforeAmount = Math.max(0, Number(currentPosition?.amount || 0));
        const soldAmount = beforeAmount > BINANCE_PENDING_RECONCILE_EPSILON
          ? Math.min(normalizedDeltaFilled, beforeAmount)
          : normalizedDeltaFilled;
        const remainingAmount = beforeAmount > BINANCE_PENDING_RECONCILE_EPSILON
          ? Math.max(0, beforeAmount - soldAmount)
          : 0;

        if (beforeAmount > BINANCE_PENDING_RECONCILE_EPSILON) {
          if (remainingAmount > BINANCE_PENDING_RECONCILE_EPSILON) {
            const scaledUnrealized = beforeAmount > BINANCE_PENDING_RECONCILE_EPSILON
              ? Number(currentPosition?.unrealized_pnl || 0) * (remainingAmount / beforeAmount)
              : 0;
            await tx.run(
              `UPDATE positions
                  SET amount = $1,
                      avg_price = $2,
                      unrealized_pnl = $3,
                      updated_at = now()
                WHERE symbol = $4
                  AND exchange = 'binance'
                  AND paper = $5
                  AND COALESCE(trade_mode, 'normal') = $6`,
              [
                remainingAmount,
                Math.max(0, Number(currentPosition?.avg_price || 0)),
                scaledUnrealized,
                payload.symbol,
                Boolean(payload.paperMode),
                effectiveTradeMode,
              ],
            );
          } else {
            await tx.run(
              `DELETE FROM positions
                WHERE symbol = $1
                  AND exchange = 'binance'
                  AND paper = $2
                  AND COALESCE(trade_mode, 'normal') = $3`,
              [payload.symbol, Boolean(payload.paperMode), effectiveTradeMode],
            );
          }
        }

        const isPartialExit = beforeAmount > BINANCE_PENDING_RECONCILE_EPSILON
          ? remainingAmount > BINANCE_PENDING_RECONCILE_EPSILON
          : false;
        const partialExitRatio = beforeAmount > BINANCE_PENDING_RECONCILE_EPSILON
          ? normalizePartialExitRatio(Math.min(1, soldAmount / beforeAmount))
          : null;
        const insertedTradeRow = await tx.get(
          `INSERT INTO trades
             (signal_id, symbol, side, amount, price, total_usdt, paper, exchange, trade_mode,
              partial_exit, partial_exit_ratio, remaining_amount,
              execution_origin, quality_flag, exclude_from_learning, incident_link)
           VALUES
             ($1, $2, 'sell', $3, $4, $5, $6, 'binance', $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING id, signal_id, symbol, side, amount, price, total_usdt, paper, exchange, trade_mode, incident_link,
                     COALESCE(partial_exit, false) AS partial_exit, partial_exit_ratio, remaining_amount`,
          [
            payload.signalId,
            payload.symbol,
            soldAmount,
            unitPrice,
            totalUsdt,
            Boolean(payload.paperMode),
            effectiveTradeMode,
            isPartialExit,
            partialExitRatio,
            isPartialExit ? remainingAmount : 0,
            qualityContext.executionOrigin,
            qualityContext.qualityFlag,
            Boolean(qualityContext.excludeFromLearning),
            deltaIncidentLink,
          ],
        );
        const trade = normalizePendingReconcileTradeRow(insertedTradeRow);
        trade.executionOrigin = qualityContext.executionOrigin;
        trade.qualityFlag = qualityContext.qualityFlag;
        trade.excludeFromLearning = Boolean(qualityContext.excludeFromLearning);
        trade.incidentLink = deltaIncidentLink;
        return {
          deduped: false,
          trade,
          tradeModeUsed: effectiveTradeMode,
        };
      }

      return {
        deduped: false,
        trade: null,
        tradeModeUsed: signalTradeMode,
      };
    });

    if (!transactional?.trade) {
      return { applied: false, trade: null, tradeModeUsed: transactional?.tradeModeUsed || signalTradeMode, appliedFilledQty: 0, appliedCost: 0 };
    }

    const trade = transactional.trade;
    const journalResult = await ensurePendingReconcileJournalRecorded({
      trade,
      signalId: payload.signalId,
      pendingMeta: payload.pendingMeta,
      source: 'pending_reconcile_apply',
      exitReason: 'order_pending_reconcile_delta',
    });
    if (!journalResult.ok) {
      console.warn(`  ⚠️ pending reconcile journal 보강 대기: ${journalResult.reason}`);
      await notifyError(`헤파이스토스 pending reconcile journal 대기 — ${payload.symbol} ${payload.action}`, journalResult.reason).catch(() => {});
    }

    if (payload.action === ACTIONS.BUY) {
      await syncCryptoStrategyExecutionState({
        symbol: payload.symbol,
        tradeMode: transactional.tradeModeUsed || signalTradeMode,
        lifecycleStatus: stateCode === 'order_reconciled'
          ? 'position_open'
          : 'position_open_partial_fill_pending',
        recommendation: 'HOLD',
        reasonCode: stateCode,
        reason: 'BUY pending 체결 delta 정산',
        trade,
        executionMission: payload.signal?.executionMission || null,
        updatedBy: 'hephaestos_pending_reconcile_apply',
      }).catch(() => null);
    } else if (payload.action === ACTIONS.SELL) {
      const remainingAmount = Math.max(0, Number(trade?.remainingAmount || 0));
      const lifecycleStatus = remainingAmount > BINANCE_PENDING_RECONCILE_EPSILON
        ? (stateCode === 'order_reconciled' ? 'partial_exit_executed' : 'partial_exit_pending_reconcile')
        : (stateCode === 'order_reconciled' ? 'position_closed' : 'exit_order_pending_reconcile');
      await syncCryptoStrategyExecutionState({
        symbol: payload.symbol,
        tradeMode: transactional.tradeModeUsed || signalTradeMode,
        lifecycleStatus,
        recommendation: remainingAmount > BINANCE_PENDING_RECONCILE_EPSILON ? 'ADJUST' : 'EXIT',
        reasonCode: stateCode,
        reason: 'SELL pending 체결 delta 정산',
        trade,
        partialExitRatio: trade?.partialExitRatio ?? null,
        executionMission: payload.signal?.executionMission || null,
        updatedBy: 'hephaestos_pending_reconcile_apply',
      }).catch(() => null);
    }

    return {
      applied: true,
      deduped: Boolean(transactional.deduped),
      trade,
      tradeModeUsed: transactional.tradeModeUsed || signalTradeMode,
      appliedFilledQty: normalizedDeltaFilled,
      appliedCost: totalUsdt,
    };
  }

  async function syncPendingReconcileSnapshotState({
    payload,
    tradeMode,
    stateCode = 'order_reconciled',
  } = {}) {
    if (!payload) return;
    const effectiveTradeMode = tradeMode || payload.tradeMode || 'normal';
    if (payload.action === ACTIONS.BUY) {
      await syncCryptoStrategyExecutionState({
        symbol: payload.symbol,
        tradeMode: effectiveTradeMode,
        lifecycleStatus: stateCode === 'order_reconciled'
          ? 'position_open'
          : 'position_open_partial_fill_pending',
        recommendation: 'HOLD',
        reasonCode: stateCode,
        reason: 'BUY pending 체결 상태 갱신',
        updatedBy: 'hephaestos_pending_reconcile_snapshot',
      }).catch(() => null);
      return;
    }

    if (payload.action === ACTIONS.SELL) {
      const position = payload.paperMode
        ? await db.getPaperPosition(payload.symbol, 'binance', effectiveTradeMode).catch(() => null)
        : await db.getLivePosition(payload.symbol, 'binance', effectiveTradeMode).catch(() => null);
      const remainingAmount = Math.max(0, Number(position?.amount || 0));
      const lifecycleStatus = remainingAmount > BINANCE_PENDING_RECONCILE_EPSILON
        ? (stateCode === 'order_reconciled' ? 'partial_exit_executed' : 'partial_exit_pending_reconcile')
        : (stateCode === 'order_reconciled' ? 'position_closed' : 'exit_order_pending_reconcile');
      await syncCryptoStrategyExecutionState({
        symbol: payload.symbol,
        tradeMode: effectiveTradeMode,
        lifecycleStatus,
        recommendation: remainingAmount > BINANCE_PENDING_RECONCILE_EPSILON ? 'ADJUST' : 'EXIT',
        reasonCode: stateCode,
        reason: 'SELL pending 체결 상태 갱신',
        updatedBy: 'hephaestos_pending_reconcile_snapshot',
      }).catch(() => null);
    }
  }

  async function markBinanceOrderPendingReconcileSignal(signalId, {
    symbol,
    action,
    amountUsdt = 0,
    tradeMode = 'normal',
    paperMode = false,
    orderMeta = {},
    existingRecordedFilledQty = 0,
    existingRecordedCost = 0,
    appliedFilledQty = 0,
    appliedCost = 0,
    reconcileError = null,
    orderStillOpen = null,
    pendingMeta = {},
  } = {}) {
    if (!signalId) return null;
    const currentPendingMeta = await loadSignalPendingReconcileMeta(signalId).catch(() => ({}));
    const providedPendingMeta = pendingMeta && typeof pendingMeta === 'object' ? pendingMeta : {};
    const basePendingMeta = {
      ...currentPendingMeta,
      ...providedPendingMeta,
    };
    const preservedJournalPending = basePendingMeta?.journalPending && typeof basePendingMeta.journalPending === 'object'
      ? basePendingMeta.journalPending
      : null;
    const filledQty = Math.max(0, Number(orderMeta?.filled || 0));
    const expectedQty = Math.max(0, Number(orderMeta?.amount || 0));
    const price = Math.max(0, Number(orderMeta?.price || orderMeta?.average || 0));
    const cost = Math.max(0, Number(orderMeta?.cost || (filledQty * price)));
    const state = resolveBinancePendingQueueState({
      status: orderMeta?.status || 'unknown',
      filledQty,
      expectedQty,
      orderStillOpen,
    });
    const baseRecordedFilled = Math.max(0, Number(existingRecordedFilledQty || 0));
    const baseRecordedCost = Math.max(0, Number(existingRecordedCost || 0));
    const safeAppliedFilled = Math.max(0, Number(reconcileError ? 0 : (appliedFilledQty || 0)));
    const safeAppliedCost = Math.max(0, Number(reconcileError ? 0 : (appliedCost || 0)));
    const nextRecordedFilledQty = Math.min(
      filledQty,
      Math.max(baseRecordedFilled, baseRecordedFilled + safeAppliedFilled),
    );
    let nextRecordedCost = Math.max(baseRecordedCost, baseRecordedCost + safeAppliedCost);
    if (cost > BINANCE_PENDING_RECONCILE_EPSILON) {
      nextRecordedCost = Math.min(cost, nextRecordedCost);
    }
    const queueStatus = reconcileError ? 'retrying' : state.queueStatus;
    const followUpRequired = reconcileError ? true : state.followUpRequired;

    const reason = reconcileError
      ? `정산 반영 실패 — 재시도 대기 (${String(reconcileError).slice(0, 96)})`
      : state.code === 'order_reconciled'
        ? `주문 정산 완료 (${filledQty.toFixed(8)} @ ${price > 0 ? price.toFixed(8) : 'N/A'})`
        : state.code === 'partial_fill_pending'
          ? `부분체결 대기 (${filledQty.toFixed(8)} / ${expectedQty > 0 ? expectedQty.toFixed(8) : '?'})`
          : `주문 접수됨 — 체결 대기 (orderKey=${orderMeta?.orderId || orderMeta?.clientOrderId || 'N/A'})`;

    await db.updateSignalBlock(signalId, {
      status: SIGNAL_STATUS.EXECUTED,
      reason: reason.slice(0, 180),
      code: reconcileError ? 'order_pending_reconcile' : state.code,
    });

    await db.mergeSignalBlockMeta(signalId, {
      pendingReconcile: {
        ...basePendingMeta,
        exchange: 'binance',
        market: 'crypto',
        symbol,
        orderSymbol: String(orderMeta?.orderSymbol || basePendingMeta?.orderSymbol || symbol || '').trim().toUpperCase() || symbol,
        action,
        tradeMode,
        amountUsdt: Number(amountUsdt || 0),
        paperMode: Boolean(paperMode),
        orderId: orderMeta?.orderId || null,
        clientOrderId: orderMeta?.clientOrderId || basePendingMeta?.clientOrderId || null,
        submittedAt: orderMeta?.submittedAt
          || (orderMeta?.submittedAtMs ? new Date(Number(orderMeta.submittedAtMs)).toISOString() : null)
          || basePendingMeta?.submittedAt
          || new Date().toISOString(),
        submittedAtMs: Number(orderMeta?.submittedAtMs || 0) > 0
          ? Number(orderMeta.submittedAtMs)
          : (Number(basePendingMeta?.submittedAtMs || 0) > 0 ? Number(basePendingMeta.submittedAtMs) : undefined),
        verificationStatus: String(orderMeta?.status || 'unknown'),
        expectedQty,
        filledQty,
        recordedFilledQty: nextRecordedFilledQty,
        recordedCost: nextRecordedCost,
        lastAppliedFilledDelta: safeAppliedFilled,
        lastAppliedCostDelta: safeAppliedCost,
        price,
        rawPrice: Number(orderMeta?.rawPrice || 0) > 0 ? Number(orderMeta.rawPrice) : undefined,
        rawCost: Number(orderMeta?.rawCost || 0) > 0 ? Number(orderMeta.rawCost) : undefined,
        quoteAsset: orderMeta?.quoteAsset || basePendingMeta?.quoteAsset || undefined,
        signalQuoteAsset: orderMeta?.signalQuoteAsset || basePendingMeta?.signalQuoteAsset || undefined,
        quoteConversionApplied: Boolean(orderMeta?.quoteConversionApplied),
        quoteConversionPair: orderMeta?.quoteConversionPair || basePendingMeta?.quoteConversionPair || undefined,
        quoteConversionRate: Number(orderMeta?.quoteConversionRate || 0) > 0
          ? Number(orderMeta.quoteConversionRate)
          : (Number(basePendingMeta?.quoteConversionRate || 0) > 0 ? Number(basePendingMeta.quoteConversionRate) : undefined),
        btcReferencePrice: Number(orderMeta?.btcReferencePrice || 0) > 0
          ? Number(orderMeta.btcReferencePrice)
          : (Number(basePendingMeta?.btcReferencePrice || 0) > 0 ? Number(basePendingMeta.btcReferencePrice) : undefined),
        queueStatus,
        followUpRequired,
        reconcileError: reconcileError ? String(reconcileError).slice(0, 240) : null,
        updatedAt: new Date().toISOString(),
        ...(preservedJournalPending ? { journalPending: preservedJournalPending } : {}),
      },
    });

    return {
      ...state,
      queueStatus,
      followUpRequired,
      recordedFilledQty: nextRecordedFilledQty,
      recordedCost: nextRecordedCost,
    };
  }

  return {
    findPendingReconcileDeltaTrade,
    getPendingReconcileAppliedSnapshot,
    loadBinancePendingReconcileTrade,
    hasPendingReconcileJournalCoverage,
    markBinancePendingReconcileJournalState,
    ensurePendingReconcileJournalRecorded,
    applyBinancePendingReconcileDelta,
    syncPendingReconcileSnapshotState,
    markBinanceOrderPendingReconcileSignal,
  };
}

export default {
  createPendingReconcileLedger,
};
