// @ts-nocheck
/**
 * Mutating pending-reconcile queue runners for Hephaestos.
 *
 * The runner is dependency-injected so hephaestos.ts can keep the exact runtime
 * contracts while this file owns queue orchestration and retry policy.
 */

import {
  computeBinancePendingRecordedProgress,
  isPendingReconcileQuoteConversionError,
  resolveBinancePendingQueueState,
  BINANCE_PENDING_RECONCILE_EPSILON,
} from '../../shared/binance-order-reconcile.ts';
import {
  extractClientOrderId,
  extractExchangeOrderId,
} from '../../shared/binance-order-execution-normalizer.ts';
import {
  buildFetchFailurePendingReconcileMeta,
  buildMissingPendingReconcileKeysResult,
  buildQuoteConversionManualReconcileMeta,
  normalizePendingReconcileTradeModes,
  summarizePendingReconcileResults,
} from './binance-order-reconcile.ts';

export function createPendingReconcileQueueProcessor(context = {}) {
  const {
    ACTIONS,
    SIGNAL_STATUS,
    db,
    delay,
    notifyError,
    notifyOperationalReview,
    parseSignalBlockMeta,
    isSyntheticOrTestSignalContext,
    buildBinancePendingReconcilePayload,
    fetchBinanceOrder,
    isBinanceOrderStillOpen,
    applyBinancePendingReconcileDelta,
    markBinanceOrderPendingReconcileSignal,
    getPendingReconcileAppliedSnapshot,
    normalizePendingReconcileOrderUnits,
    syncPendingReconcileSnapshotState,
  } = context;

  async function processBinancePendingReconcileQueue({
    tradeModes = [],
    limit = 40,
    delayMs = 150,
    deps = {},
  } = {}) {
    const fetchOrderFn = typeof deps?.fetchOrder === 'function'
      ? deps.fetchOrder
      : fetchBinanceOrder;
    const isOrderStillOpenFn = typeof deps?.isOrderStillOpen === 'function'
      ? deps.isOrderStillOpen
      : isBinanceOrderStillOpen;
    const applyDeltaFn = typeof deps?.applyDelta === 'function'
      ? deps.applyDelta
      : applyBinancePendingReconcileDelta;
    const markSignalFn = typeof deps?.markSignal === 'function'
      ? deps.markSignal
      : markBinanceOrderPendingReconcileSignal;
    const notifyOperationalReviewFn = typeof deps?.notifyOperationalReview === 'function'
      ? deps.notifyOperationalReview
      : notifyOperationalReview;

    const modeFilter = normalizePendingReconcileTradeModes(tradeModes);

    const candidates = await db.query(
      `SELECT id, symbol, action, trade_mode, block_code, block_meta, amount_usdt
         FROM signals
        WHERE exchange = 'binance'
          AND status = 'executed'
          AND COALESCE(trade_mode, 'normal') = ANY($1::text[])
          AND COALESCE(block_code, '') IN ('order_pending_reconcile', 'partial_fill_pending')
        ORDER BY created_at ASC
        LIMIT $2`,
      [modeFilter, Math.max(1, Math.min(200, Number(limit || 40)))],
    );

    const results = [];
    for (const row of candidates) {
      const payload = buildBinancePendingReconcilePayload(row);
      if (!payload) {
        const rowMeta = parseSignalBlockMeta(row?.block_meta);
        const pendingMeta = rowMeta?.pendingReconcile && typeof rowMeta.pendingReconcile === 'object'
          ? rowMeta.pendingReconcile
          : null;
        if (pendingMeta?.followUpRequired === true && !pendingMeta?.orderId && !pendingMeta?.clientOrderId) {
          const reason = 'pending reconcile 키(orderId/clientOrderId) 누락 — 자동 정산 불가, 수동 정산 필요';
          await db.updateSignalBlock(row.id, {
            status: SIGNAL_STATUS.FAILED,
            reason: reason.slice(0, 180),
            code: 'manual_reconcile_required',
            meta: {
              exchange: 'binance',
              symbol: row.symbol,
              action: row.action,
              pendingReconcile: pendingMeta,
            },
          }).catch(() => {});
          if (!isSyntheticOrTestSignalContext({ signalId: row.id, reasoning: row.reasoning })) {
            await notifyError(`헤파이스토스 pending reconcile 수동 정산 필요 — ${row.symbol} ${row.action}`, reason).catch(() => {});
          }
          results.push(buildMissingPendingReconcileKeysResult(row, reason));
        }
        continue;
      }
      if (!payload.followUpRequired) continue;
      try {
        const side = payload.action === ACTIONS.BUY ? 'buy' : 'sell';
        const order = await fetchOrderFn({
          symbol: payload.orderSymbol || payload.symbol,
          orderId: payload.orderId || null,
          clientOrderId: payload.clientOrderId || null,
          submittedAtMs: payload.submittedAtMs || null,
          side,
          allowAllOrdersFallback: true,
        }, payload.orderSymbol || payload.symbol);
        const status = String(order?.status || '').trim().toLowerCase() || 'unknown';
        const filledQty = Math.max(0, Number(order?.filled || 0));
        const expectedQty = Math.max(payload.expectedQty, Number(order?.amount || 0));
        const resolvedOrderId = extractExchangeOrderId(order) || payload.orderId || null;
        const resolvedClientOrderId = extractClientOrderId(order) || payload.clientOrderId || null;
        const appliedSnapshot = await getPendingReconcileAppliedSnapshot({
          signalId: payload.signalId,
          symbol: payload.symbol,
          side,
          orderId: resolvedOrderId,
          clientOrderId: resolvedClientOrderId,
        });
        const effectiveRecordedFilledQty = Math.max(payload.recordedFilledQty, Number(appliedSnapshot.appliedFilledQty || 0));
        const effectiveRecordedCost = Math.max(payload.recordedCost, Number(appliedSnapshot.appliedCost || 0));
        const effectivePayload = {
          ...payload,
          orderId: resolvedOrderId,
          clientOrderId: resolvedClientOrderId,
          recordedFilledQty: effectiveRecordedFilledQty,
          recordedCost: effectiveRecordedCost,
        };
        const rawPrice = Math.max(0, Number(order?.price || order?.average || 0));
        const rawCost = Math.max(0, Number(order?.cost || (filledQty * rawPrice)));
        const quoteNormalized = await normalizePendingReconcileOrderUnits({
          signalSymbol: payload.symbol,
          orderSymbol: payload.orderSymbol || payload.symbol,
          filledQty,
          price: rawPrice,
          cost: rawCost,
          pendingMeta: payload.pendingMeta,
          signalId: payload.signalId,
        });
        const price = quoteNormalized.convertedPrice;
        const cost = quoteNormalized.convertedCost;
        const orderStillOpen = await isOrderStillOpenFn(
          payload.orderSymbol || payload.symbol,
          resolvedOrderId,
          resolvedClientOrderId,
        );
        const state = resolveBinancePendingQueueState({
          status,
          filledQty,
          expectedQty,
          orderStillOpen,
        });
        const progress = computeBinancePendingRecordedProgress({
          exchangeFilledQty: filledQty,
          exchangeCost: cost,
          exchangePrice: price,
          recordedFilledQty: effectiveRecordedFilledQty,
          recordedCost: effectiveRecordedCost,
          applySucceeded: true,
        });

        let applyError = null;
        let applyResult = null;
        let applySucceeded = progress.deltaFilledQty <= BINANCE_PENDING_RECONCILE_EPSILON;
        if (progress.deltaFilledQty > BINANCE_PENDING_RECONCILE_EPSILON) {
          try {
            applyResult = await applyDeltaFn({
              payload: effectivePayload,
              deltaFilledQty: progress.deltaFilledQty,
              deltaCost: progress.deltaCost,
              orderPrice: price,
              stateCode: state.code,
            });
            applySucceeded = Boolean(applyResult?.applied);
          } catch (error) {
            applyError = error;
          }
        }

        const persistedProgress = computeBinancePendingRecordedProgress({
          exchangeFilledQty: filledQty,
          exchangeCost: cost,
          exchangePrice: price,
          recordedFilledQty: effectiveRecordedFilledQty,
          recordedCost: effectiveRecordedCost,
          applySucceeded: !applyError && applySucceeded,
        });
        let pendingState = null;
        try {
          pendingState = await markSignalFn(payload.signalId, {
            symbol: payload.symbol,
            action: payload.action,
            amountUsdt: payload.amountUsdt,
            tradeMode: applyResult?.tradeModeUsed || payload.tradeMode,
            paperMode: payload.paperMode,
            orderMeta: {
              orderId: resolvedOrderId,
              clientOrderId: resolvedClientOrderId,
              orderSymbol: payload.orderSymbol || payload.symbol,
              submittedAtMs: payload.submittedAtMs || null,
              status,
              amount: expectedQty,
              filled: filledQty,
              price,
              cost,
              rawPrice: quoteNormalized.rawPrice,
              rawCost: quoteNormalized.rawCost,
              quoteConversionApplied: quoteNormalized.conversionApplied,
              quoteConversionRate: quoteNormalized.conversionRate,
              quoteConversionPair: quoteNormalized.conversionPair,
              quoteAsset: quoteNormalized.orderQuote,
              signalQuoteAsset: quoteNormalized.signalQuote,
              btcReferencePrice: quoteNormalized.conversionRate,
            },
            existingRecordedFilledQty: effectiveRecordedFilledQty,
            existingRecordedCost: effectiveRecordedCost,
            appliedFilledQty: persistedProgress.appliedFilledQty,
            appliedCost: persistedProgress.appliedCost,
            reconcileError: applyError ? String(applyError?.message || applyError) : null,
            orderStillOpen,
            pendingMeta: payload.pendingMeta,
          });
        } catch (markError) {
          if (!applyError && persistedProgress.appliedFilledQty > BINANCE_PENDING_RECONCILE_EPSILON) {
            await notifyError(`헤파이스토스 pending reconcile meta 저장 실패 — ${payload.symbol} ${payload.action}`, markError).catch(() => {});
          }
          throw markError;
        }

        if (!applyError && progress.deltaFilledQty <= BINANCE_PENDING_RECONCILE_EPSILON && pendingState?.code === 'order_reconciled') {
          await syncPendingReconcileSnapshotState({
            payload: effectivePayload,
            tradeMode: applyResult?.tradeModeUsed || payload.tradeMode,
            stateCode: pendingState.code,
          }).catch(() => null);
        }

        results.push({
          signalId: payload.signalId,
          symbol: payload.symbol,
          orderSymbol: payload.orderSymbol || payload.symbol,
          action: payload.action,
          code: applyError
            ? 'reconcile_apply_failed'
            : (pendingState?.code || state.code),
          status,
          filledQty,
          appliedFilledQty: persistedProgress.appliedFilledQty,
          appliedCost: persistedProgress.appliedCost,
          queueStatus: pendingState?.queueStatus || null,
          error: applyError ? String(applyError?.message || applyError) : null,
        });

      } catch (error) {
        if (isPendingReconcileQuoteConversionError(error)) {
          const reason = `pending reconcile 단위 환산 불가 — 수동 정산 필요 (${String(error?.message || error).slice(0, 96)})`;
          await db.updateSignalBlock(payload.signalId, {
            status: SIGNAL_STATUS.FAILED,
            reason: reason.slice(0, 180),
            code: 'manual_reconcile_required',
            meta: buildQuoteConversionManualReconcileMeta({ payload, error }),
          }).catch(() => {});
          if (!isSyntheticOrTestSignalContext({ signalId: payload.signalId, reasoning: payload.signal?.reasoning })) {
            await notifyError(`헤파이스토스 pending reconcile 수동 정산 필요 — ${payload.symbol} ${payload.action}`, reason).catch(() => {});
          }
          results.push({
            signalId: payload.signalId,
            symbol: payload.symbol,
            action: payload.action,
            code: 'manual_reconcile_required',
            status: 'quote_conversion_failed',
            error: String(error?.message || error),
          });
          if (delayMs > 0) await delay(delayMs);
          continue;
        }
        await db.mergeSignalBlockMeta(
          payload.signalId,
          buildFetchFailurePendingReconcileMeta({ payload, error }),
        ).catch(() => {});
        const errorCode = String(error?.code || '').trim().toLowerCase();
        const lookupNotFound = errorCode.includes('not_found');
        if (lookupNotFound) {
          await db.mergeSignalBlockMeta(payload.signalId, {
            resolutionHint: 'manual_ack_required',
            operatorAction: 'verify_absence_then_ack_or_manual_reconcile',
            recoveryErrorCode: errorCode,
          }).catch(() => {});
          if (!isSyntheticOrTestSignalContext({ signalId: payload.signalId, reasoning: payload.signal?.reasoning })) {
            await notifyOperationalReviewFn?.(
              `헤파이스토스 pending reconcile 수동 확인 필요 — ${payload.symbol} ${payload.action}`,
              { message: `${payload.symbol} clientOrderId/orderId 조회 결과가 비어 있음(${errorCode}) — 부재 확인 후 안전 ack 또는 정산 여부 결정 필요` },
            ).catch(() => {});
          }
        }
        results.push({
          signalId: payload.signalId,
          symbol: payload.symbol,
          action: payload.action,
          code: 'reconcile_fetch_failed',
          status: 'error',
          error: String(error?.message || error),
        });
      }
      if (delayMs > 0) await delay(delayMs);
    }

    return {
      candidates: candidates.length,
      processed: results.length,
      summary: summarizePendingReconcileResults(results),
      results,
    };
  }

  return processBinancePendingReconcileQueue;
}

export function createPendingJournalRepairQueueProcessor(context = {}) {
  const {
    ACTIONS,
    db,
    delay,
    buildBinancePendingReconcilePayload,
    loadBinancePendingReconcileTrade,
    ensurePendingReconcileJournalRecorded,
    markBinancePendingReconcileJournalState,
  } = context;

  async function processBinancePendingJournalRepairQueue({
    tradeModes = [],
    limit = 40,
    delayMs = 120,
    deps = {},
  } = {}) {
    const modeFilter = normalizePendingReconcileTradeModes(tradeModes);
    const loadTradeFn = typeof deps?.loadTrade === 'function'
      ? deps.loadTrade
      : loadBinancePendingReconcileTrade;
    const ensureJournalFn = typeof deps?.ensureJournal === 'function'
      ? deps.ensureJournal
      : ensurePendingReconcileJournalRecorded;

    const candidates = await db.query(
      `SELECT id, symbol, action, trade_mode, block_code, block_meta, amount_usdt
         FROM signals
        WHERE exchange = 'binance'
          AND status = 'executed'
          AND COALESCE(trade_mode, 'normal') = ANY($1::text[])
          AND COALESCE(block_meta->'pendingReconcile'->'journalPending'->>'followUpRequired', 'false') = 'true'
        ORDER BY created_at ASC
        LIMIT $2`,
      [modeFilter, Math.max(1, Math.min(200, Number(limit || 40)))],
    );

    const results = [];
    for (const row of candidates) {
      const payload = buildBinancePendingReconcilePayload(row);
      if (!payload) continue;
      const journalPending = payload.pendingMeta?.journalPending && typeof payload.pendingMeta.journalPending === 'object'
        ? payload.pendingMeta.journalPending
        : {};
      if (journalPending.followUpRequired !== true) continue;
      const side = payload.action === ACTIONS.BUY ? 'buy' : 'sell';
      try {
        const trade = await loadTradeFn({
          signalId: payload.signalId,
          symbol: payload.symbol,
          side,
          tradeId: journalPending.tradeId || null,
          incidentLink: journalPending.incidentLink || null,
        });
        if (!trade) {
          const reason = 'journal_trade_not_found';
          await markBinancePendingReconcileJournalState(payload.signalId, {
            pendingMeta: payload.pendingMeta,
            trade: {
              id: journalPending.tradeId || null,
              symbol: payload.symbol,
              side,
              incidentLink: journalPending.incidentLink || null,
            },
            followUpRequired: true,
            queueStatus: 'queued',
            attemptIncrement: 1,
            lastError: reason,
            source: 'pending_reconcile_journal_repair',
          }).catch(() => {});
          results.push({
            signalId: payload.signalId,
            symbol: payload.symbol,
            action: payload.action,
            code: 'journal_repair_failed',
            reason,
          });
          continue;
        }

        const journalResult = await ensureJournalFn({
          trade,
          signalId: payload.signalId,
          pendingMeta: payload.pendingMeta,
          source: 'pending_reconcile_journal_repair',
          exitReason: 'order_pending_reconcile_delta',
        });
        results.push({
          signalId: payload.signalId,
          symbol: payload.symbol,
          action: payload.action,
          code: journalResult?.ok ? 'journal_repaired' : 'journal_repair_failed',
          reason: journalResult?.ok ? null : (journalResult?.reason || 'journal_repair_failed'),
        });
      } catch (error) {
        await markBinancePendingReconcileJournalState(payload.signalId, {
          pendingMeta: payload.pendingMeta,
          trade: {
            id: journalPending.tradeId || null,
            symbol: payload.symbol,
            side,
            incidentLink: journalPending.incidentLink || null,
          },
          followUpRequired: true,
          queueStatus: 'queued',
          attemptIncrement: 1,
          lastError: String(error?.message || error),
          source: 'pending_reconcile_journal_repair',
        }).catch(() => {});
        results.push({
          signalId: payload.signalId,
          symbol: payload.symbol,
          action: payload.action,
          code: 'journal_repair_failed',
          reason: String(error?.message || error),
        });
      }
      if (delayMs > 0) await delay(delayMs);
    }

    return {
      candidates: candidates.length,
      processed: results.length,
      summary: {
        repaired: results.filter((item) => item.code === 'journal_repaired').length,
        failed: results.filter((item) => item.code === 'journal_repair_failed').length,
      },
      results,
    };
  }

  return processBinancePendingJournalRepairQueue;
}

export default {
  createPendingReconcileQueueProcessor,
  createPendingJournalRepairQueueProcessor,
};
