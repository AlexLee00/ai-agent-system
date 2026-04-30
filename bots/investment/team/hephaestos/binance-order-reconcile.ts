// @ts-nocheck
/**
 * Pure helpers for Hephaestos Binance order reconciliation.
 *
 * Keep DB writes, order fetches, and wallet mutations in hephaestos.ts while
 * moving deterministic queue policy here. This gives us a safe seam for the
 * larger binance-order-reconcile extraction without changing trading behavior.
 */

const DEFAULT_PENDING_RECONCILE_TRADE_MODES = ['normal', 'validation'];

const PENDING_RECONCILE_FAILURE_CODES = new Set([
  'reconcile_fetch_failed',
  'reconcile_apply_failed',
  'manual_reconcile_required',
]);

function isLookupNotFoundCode(code = null) {
  return String(code || '').trim().toLowerCase().includes('not_found');
}

export function normalizePendingReconcileTradeModes(tradeModes = []) {
  const normalizedModes = Array.from(new Set(
    (Array.isArray(tradeModes) ? tradeModes : [])
      .map((mode) => String(mode || '').trim())
      .filter(Boolean),
  ));
  return normalizedModes.length > 0 ? normalizedModes : [...DEFAULT_PENDING_RECONCILE_TRADE_MODES];
}

export function buildMissingPendingReconcileKeysResult(row = {}, reason = '') {
  return {
    signalId: row.id,
    symbol: row.symbol,
    action: row.action,
    code: 'manual_reconcile_required',
    status: 'missing_order_keys',
    error: reason,
  };
}

export function buildQuoteConversionManualReconcileMeta({ payload = {}, error = null } = {}) {
  return {
    exchange: 'binance',
    symbol: payload.symbol,
    action: payload.action,
    orderId: payload.orderId || null,
    clientOrderId: payload.clientOrderId || null,
    orderSymbol: payload.orderSymbol || payload.symbol,
    pendingReconcile: payload.pendingMeta || null,
    conversionError: String(error?.message || error).slice(0, 240),
    ...(error?.meta || {}),
  };
}

export function buildFetchFailurePendingReconcileMeta({ payload = {}, error = null } = {}) {
  return {
    pendingReconcile: {
      ...payload.pendingMeta,
      exchange: 'binance',
      symbol: payload.symbol,
      orderSymbol: payload.orderSymbol || payload.symbol,
      action: payload.action,
      orderId: payload.orderId,
      clientOrderId: payload.clientOrderId || null,
      queueStatus: 'queued',
      followUpRequired: true,
      reconcileError: String(error?.message || error).slice(0, 240),
      updatedAt: new Date().toISOString(),
    },
  };
}

export function summarizePendingReconcileResults(results = []) {
  return {
    completed: results.filter((item) => item.code === 'order_reconciled').length,
    partial: results.filter((item) => item.code === 'partial_fill_pending').length,
    queued: results.filter((item) => item.code === 'order_pending_reconcile').length,
    failed: results.filter((item) => PENDING_RECONCILE_FAILURE_CODES.has(item.code)).length,
  };
}

export function createBinanceExecutionReconcileHandler(context = {}) {
  const {
    ACTIONS,
    BINANCE_PENDING_RECONCILE_EPSILON,
    computeBinancePendingRecordedProgress,
    extractClientOrderId,
    extractExchangeOrderId,
    fetchBinanceOrder,
    isDefinitiveBinanceOrderLookupError,
    isPendingReconcileQuoteConversionError,
    normalizePendingReconcileOrderUnits,
    isSyntheticOrTestSignalContext,
    notifyError,
    toEpochMs,
    isBinanceOrderStillOpen,
    resolveBinancePendingQueueState,
    getPendingReconcileAppliedSnapshot,
    applyBinancePendingReconcileDelta,
    markBinanceOrderPendingReconcileSignal,
    syncPendingReconcileSnapshotState,
    reconcileLivePositionsWithBrokerBalance,
  } = context;

  async function enqueueClientOrderPendingRetry({
    signalId,
    symbol,
    action,
    amountUsdt = 0,
    signalTradeMode = 'normal',
    effectivePaperMode = false,
    pendingOrder = {},
    pendingMeta = {},
    pendingFilled = 0,
    pendingRawPrice = 0,
    pendingRawCost = 0,
    persistFailure = async () => {},
    signal = null,
    deps = {},
  } = {}) {
    const markSignalFn = typeof deps?.markSignal === 'function'
      ? deps.markSignal
      : markBinanceOrderPendingReconcileSignal;
    const reconcilePositionsFn = typeof deps?.reconcileLivePositions === 'function'
      ? deps.reconcileLivePositions
      : reconcileLivePositionsWithBrokerBalance;
    const notifyErrorFn = typeof deps?.notifyError === 'function'
      ? deps.notifyError
      : notifyError;
    const notifyOperationalReviewFn = typeof deps?.notifyOperationalReview === 'function'
      ? deps.notifyOperationalReview
      : null;

    try {
      await markSignalFn(signalId, {
        symbol,
        action,
        amountUsdt,
        tradeMode: signalTradeMode,
        paperMode: effectivePaperMode,
        orderMeta: {
          orderId: null,
          clientOrderId: pendingOrder?.clientOrderId || null,
          orderSymbol: pendingOrder?.orderSymbol || symbol,
          submittedAtMs: pendingOrder?.submittedAtMs || null,
          status: pendingOrder?.status || 'unknown',
          amount: Number(pendingOrder?.amount || 0),
          filled: pendingFilled,
          price: 0,
          cost: 0,
          rawPrice: pendingRawPrice,
          rawCost: pendingRawCost,
          quoteConversionApplied: false,
          quoteConversionRate: null,
          quoteConversionPair: null,
          quoteAsset: null,
          signalQuoteAsset: null,
          btcReferencePrice: null,
        },
        existingRecordedFilledQty: 0,
        existingRecordedCost: 0,
        appliedFilledQty: 0,
        appliedCost: 0,
        reconcileError: pendingOrder?.recoveryError || 'client_order_lookup_retry',
        orderStillOpen: null,
        pendingMeta,
      });
    } catch (markError) {
      const reason = `${symbol} pending reconcile 큐 기록 실패 — 자동 재시도 상태 저장 실패`;
      await persistFailure(reason, {
        code: 'pending_reconcile_enqueue_failed',
        meta: {
          exchange: 'binance',
          symbol,
          action,
          orderId: null,
          clientOrderId: pendingOrder?.clientOrderId || null,
          orderSymbol: pendingOrder?.orderSymbol || symbol,
          status: pendingOrder?.status || 'unknown',
          submittedAtMs: pendingOrder?.submittedAtMs || null,
          recoveryError: pendingOrder?.recoveryError || null,
          enqueueError: String(markError?.message || markError).slice(0, 240),
          source: pendingMeta?.source || null,
          orderAttempted: true,
        },
      });
      if (!isSyntheticOrTestSignalContext({ signalId, reasoning: signal?.reasoning })) {
        await notifyErrorFn(`헤파이스토스 pending reconcile 큐 기록 실패 — ${symbol} ${action}`, markError).catch(() => {});
      }
      return {
        success: false,
        pendingReconcile: false,
        code: 'pending_reconcile_enqueue_failed',
        verificationStatus: pendingOrder?.status || 'unknown',
        orderId: null,
        clientOrderId: pendingOrder?.clientOrderId || null,
        orderSymbol: pendingOrder?.orderSymbol || symbol,
        error: String(markError?.message || markError),
      };
    }

    await reconcilePositionsFn().catch(() => []);
    console.warn(`  ⚠️ ${symbol} orderId 미확인(clientOrderId=${pendingOrder?.clientOrderId || 'N/A'}) — pending reconcile 재시도 큐로 유지`);
    return {
      success: true,
      pendingReconcile: true,
      orderId: null,
      clientOrderId: pendingOrder?.clientOrderId || null,
      orderSymbol: pendingOrder?.orderSymbol || symbol,
      verificationStatus: pendingOrder?.status || 'unknown',
      queuedForRetry: true,
      error: pendingOrder?.recoveryError || null,
    };
  }

  async function handleExecutionPendingReconcileError({
    error,
    signal = null,
    signalId = null,
    symbol = '',
    action = '',
    amountUsdt = 0,
    signalTradeMode = 'normal',
    effectivePaperMode = false,
    persistFailure = async () => {},
    executionClientOrderId = null,
    executionSubmittedAtMs = null,
  } = {}) {
    let pendingSourceError = error;
    const syntheticBridgePendingEligible = (() => {
      const code = String(error?.code || '').trim().toLowerCase();
      if (code !== 'binance_mcp_mutating_bridge_failed') return false;
      return Boolean(executionClientOrderId) && (action === ACTIONS.BUY || action === ACTIONS.SELL);
    })();
    if (syntheticBridgePendingEligible) {
      const bridgeMeta = error?.meta && typeof error.meta === 'object' ? error.meta : {};
      const syntheticPendingError = /** @type {any} */ (new Error(
        `order_fill_unverified:${symbol}:bridge_error_after_submit:0:0`,
      ));
      syntheticPendingError.code = 'order_fill_unverified';
      syntheticPendingError.meta = {
        symbol,
        side: String(action || '').trim().toLowerCase() || null,
        orderSymbol: String(bridgeMeta.orderSymbol || bridgeMeta.symbol || symbol || '').trim().toUpperCase() || symbol,
        orderId: bridgeMeta.orderId || null,
        clientOrderId: bridgeMeta.clientOrderId || executionClientOrderId || null,
        status: String(bridgeMeta.status || 'bridge_error_after_submit').trim().toLowerCase() || 'bridge_error_after_submit',
        amount: Number(bridgeMeta.amount || 0),
        filled: Number(bridgeMeta.filled || 0),
        price: Number(bridgeMeta.price || 0),
        cost: Number(bridgeMeta.cost || 0),
        amountUsdt: Number(bridgeMeta.amountUsdt || amountUsdt || 0),
        submittedAtMs: executionSubmittedAtMs,
        source: 'binance_mcp_mutating_bridge_failed',
      };
      syntheticPendingError.cause = error;
      pendingSourceError = syntheticPendingError;
    }

    const pendingReconcileEligible = (() => {
      const code = String(pendingSourceError?.code || '').trim().toLowerCase();
      if (code === 'order_pending_fill_verification') return true;
      if (code === 'order_fill_unverified') {
        const meta = pendingSourceError?.meta && typeof pendingSourceError.meta === 'object' ? pendingSourceError.meta : {};
        return Boolean(meta?.orderId || meta?.clientOrderId);
      }
      return false;
    })();
    if (!pendingReconcileEligible) {
      return { handled: false, error: pendingSourceError };
    }

    const pendingMeta = pendingSourceError?.meta && typeof pendingSourceError.meta === 'object' ? pendingSourceError.meta : {};
    const pendingOrderSymbol = String(pendingMeta.orderSymbol || pendingMeta.symbol || symbol || '').trim().toUpperCase() || symbol;
    const pendingOrder = {
      id: pendingMeta.orderId || null,
      orderId: pendingMeta.orderId || null,
      clientOrderId: pendingMeta.clientOrderId || null,
      orderSymbol: pendingOrderSymbol,
      submittedAtMs: toEpochMs(pendingMeta.submittedAtMs || pendingMeta.submittedAt || signal?.created_at || null),
      status: String(pendingMeta.status || 'unknown').trim().toLowerCase() || 'unknown',
      amount: Number(pendingMeta.amount || 0),
      filled: Number(pendingMeta.filled || 0),
      price: Number(pendingMeta.price || 0),
      average: Number(pendingMeta.price || 0),
      cost: Number(pendingMeta.cost || (Number(pendingMeta.filled || 0) * Number(pendingMeta.price || 0))),
    };
    let pendingFilled = Math.max(0, Number(pendingOrder.filled || 0));
    let pendingRawPrice = Math.max(0, Number(pendingOrder.price || pendingOrder.average || 0));
    let pendingRawCost = Math.max(0, Number(pendingOrder.cost || (pendingFilled * pendingRawPrice)));

    if (!pendingOrder.orderId && pendingOrder.clientOrderId) {
      try {
        const recoveredOrder = await fetchBinanceOrder({
          symbol: pendingOrder.orderSymbol || symbol,
          clientOrderId: pendingOrder.clientOrderId,
          submittedAtMs: pendingOrder.submittedAtMs || null,
          side: action === ACTIONS.BUY ? 'buy' : 'sell',
          allowAllOrdersFallback: true,
        });
        if (recoveredOrder && typeof recoveredOrder === 'object') {
          pendingOrder.orderId = extractExchangeOrderId(recoveredOrder) || null;
          pendingOrder.clientOrderId = extractClientOrderId(recoveredOrder) || pendingOrder.clientOrderId;
          pendingOrder.status = String(recoveredOrder.status || pendingOrder.status || 'unknown').trim().toLowerCase() || 'unknown';
          pendingOrder.amount = Number(recoveredOrder.amount || pendingOrder.amount || 0);
          pendingOrder.filled = Number(recoveredOrder.filled || pendingOrder.filled || 0);
          pendingOrder.price = Number(recoveredOrder.price || recoveredOrder.average || pendingOrder.price || 0);
          pendingOrder.average = Number(recoveredOrder.average || pendingOrder.price || 0);
          pendingOrder.cost = Number(recoveredOrder.cost || (pendingOrder.filled * pendingOrder.price) || 0);
        }
      } catch (recoveryError) {
        pendingOrder.recoveryError = String(recoveryError?.message || recoveryError).slice(0, 240);
        pendingOrder.recoveryErrorCode = String(recoveryError?.code || '').trim().toLowerCase() || null;
      }
      pendingFilled = Math.max(0, Number(pendingOrder.filled || 0));
      pendingRawPrice = Math.max(0, Number(pendingOrder.price || pendingOrder.average || 0));
      pendingRawCost = Math.max(0, Number(pendingOrder.cost || (pendingFilled * pendingRawPrice)));
    }

    if (!pendingOrder.orderId) {
      const hasClientOrderKey = Boolean(pendingOrder.clientOrderId);
      const definitiveLookupFailure = isDefinitiveBinanceOrderLookupError(pendingOrder.recoveryErrorCode);
      const lookupNotFound = hasClientOrderKey && isLookupNotFoundCode(pendingOrder.recoveryErrorCode);
      if (!hasClientOrderKey || definitiveLookupFailure) {
        const reason = lookupNotFound
          ? `${symbol} clientOrderId 조회 결과가 비어 있음(${pendingOrder.recoveryErrorCode}) — 수동 확인 후 안전 ack 또는 정산 여부 결정 필요`
          : definitiveLookupFailure
          ? `${symbol} clientOrderId 조회 결과가 확정 실패(${pendingOrder.recoveryErrorCode}) — 수동 정산 필요`
          : `${symbol} 주문 식별키(orderId/clientOrderId) 누락 — 자동 pending reconcile 불가 (수동 정산 필요)`;
        await persistFailure(reason, {
          code: 'manual_reconcile_required',
          meta: {
            exchange: 'binance',
            symbol,
            action,
            orderId: null,
            clientOrderId: pendingOrder.clientOrderId || null,
            orderSymbol: pendingOrder.orderSymbol || symbol,
            status: pendingOrder.status,
            amount: Number(pendingOrder.amount || 0),
            filled: pendingFilled,
            rawPrice: pendingRawPrice,
            rawCost: pendingRawCost,
            submittedAtMs: pendingOrder.submittedAtMs || null,
            recoveryError: pendingOrder.recoveryError || null,
            recoveryErrorCode: pendingOrder.recoveryErrorCode || null,
            resolutionHint: lookupNotFound ? 'manual_ack_required' : 'manual_reconcile_required',
            operatorAction: lookupNotFound ? 'verify_absence_then_ack_or_manual_reconcile' : 'manual_reconcile_required',
            source: pendingMeta?.source || null,
            orderAttempted: true,
          },
        });
        if (!isSyntheticOrTestSignalContext({ signalId, reasoning: signal?.reasoning })) {
          if (lookupNotFound && notifyOperationalReviewFn) {
            await notifyOperationalReviewFn(`헤파이스토스 pending reconcile 수동 확인 필요 — ${symbol} ${action}`, { message: reason }).catch(() => {});
          } else {
            await notifyErrorFn(`헤파이스토스 pending reconcile 수동 정산 필요 — ${symbol} ${action}`, reason).catch(() => {});
          }
        }
        return {
          handled: true,
          result: {
            success: false,
            manualReconcileRequired: true,
            code: 'manual_reconcile_required',
            resolutionHint: lookupNotFound ? 'manual_ack_required' : 'manual_reconcile_required',
            verificationStatus: pendingOrder.status,
            clientOrderId: pendingOrder.clientOrderId || null,
            orderSymbol: pendingOrder.orderSymbol || symbol,
            error: reason,
          },
        };
      }

      return {
        handled: true,
        result: await enqueueClientOrderPendingRetry({
          signalId,
          symbol,
          action,
          amountUsdt,
          signalTradeMode,
          effectivePaperMode,
          pendingOrder,
          pendingMeta,
          pendingFilled,
          pendingRawPrice,
          pendingRawCost,
          persistFailure,
          signal,
        }),
      };
    }

    const pendingQuoteNormalized = await normalizePendingReconcileOrderUnits({
      signalSymbol: symbol,
      orderSymbol: pendingOrder.orderSymbol || symbol,
      filledQty: pendingFilled,
      price: pendingRawPrice,
      cost: pendingRawCost,
      pendingMeta,
      signalId,
    }).catch(async (quoteError) => {
      if (isPendingReconcileQuoteConversionError(quoteError)) {
        const reason = `${symbol} pending reconcile 단위 환산 불가 — 수동 정산 필요`;
        await persistFailure(reason, {
          code: 'manual_reconcile_required',
          meta: {
            exchange: 'binance',
            symbol,
            action,
            orderId: pendingOrder.orderId || null,
            clientOrderId: pendingOrder.clientOrderId || null,
            orderSymbol: pendingOrder.orderSymbol || symbol,
            status: pendingOrder.status,
            amount: Number(pendingOrder.amount || 0),
            filled: pendingFilled,
            rawPrice: pendingRawPrice,
            rawCost: pendingRawCost,
            conversionError: String(quoteError?.message || quoteError).slice(0, 240),
            ...(quoteError?.meta || {}),
          },
        });
        if (!isSyntheticOrTestSignalContext({ signalId, reasoning: signal?.reasoning })) {
          await notifyError(`헤파이스토스 pending reconcile 수동 정산 필요 — ${symbol} ${action}`, reason).catch(() => {});
        }
        return null;
      }
      throw quoteError;
    });
    if (!pendingQuoteNormalized) {
      return {
        handled: true,
        result: {
          success: false,
          manualReconcileRequired: true,
          code: 'manual_reconcile_required',
          verificationStatus: pendingOrder.status,
          orderId: pendingOrder.orderId || null,
          clientOrderId: pendingOrder.clientOrderId || null,
          orderSymbol: pendingOrder.orderSymbol || symbol,
          error: 'pending_reconcile_quote_conversion_failed',
        },
      };
    }

    const pendingPrice = pendingQuoteNormalized.convertedPrice;
    const pendingCost = pendingQuoteNormalized.convertedCost;
    const orderStillOpen = await isBinanceOrderStillOpen(
      pendingOrder.orderSymbol || symbol,
      pendingOrder.orderId,
      pendingOrder.clientOrderId || null,
    ).catch(() => null);
    const state = resolveBinancePendingQueueState({
      status: pendingOrder.status,
      filledQty: pendingFilled,
      expectedQty: Number(pendingOrder.amount || 0),
      orderStillOpen,
    });
    const side = action === ACTIONS.BUY ? 'buy' : 'sell';
    const appliedSnapshot = await getPendingReconcileAppliedSnapshot({
      signalId,
      symbol,
      side,
      orderId: pendingOrder.orderId || null,
      clientOrderId: pendingOrder.clientOrderId || null,
    });
    const effectiveRecordedFilledQty = Math.max(0, Number(appliedSnapshot.appliedFilledQty || 0));
    const effectiveRecordedCost = Math.max(0, Number(appliedSnapshot.appliedCost || 0));
    const payload = {
      signal,
      signalId,
      symbol,
      action,
      amountUsdt,
      tradeMode: signalTradeMode,
      paperMode: effectivePaperMode,
      orderId: pendingOrder.orderId || null,
      clientOrderId: pendingOrder.clientOrderId || null,
      orderSymbol: pendingOrder.orderSymbol || symbol,
      submittedAtMs: pendingOrder.submittedAtMs || null,
      pendingMeta,
      expectedQty: Number(pendingOrder.amount || 0),
      recordedFilledQty: effectiveRecordedFilledQty,
      recordedCost: effectiveRecordedCost,
    };
    const progress = computeBinancePendingRecordedProgress({
      exchangeFilledQty: pendingFilled,
      exchangeCost: pendingCost,
      exchangePrice: pendingPrice,
      recordedFilledQty: effectiveRecordedFilledQty,
      recordedCost: effectiveRecordedCost,
      applySucceeded: true,
    });

    let applyError = null;
    let applyResult = null;
    let applySucceeded = progress.deltaFilledQty <= BINANCE_PENDING_RECONCILE_EPSILON;
    if (progress.deltaFilledQty > BINANCE_PENDING_RECONCILE_EPSILON) {
      try {
        applyResult = await applyBinancePendingReconcileDelta({
          payload,
          deltaFilledQty: progress.deltaFilledQty,
          deltaCost: progress.deltaCost,
          orderPrice: pendingPrice,
          stateCode: state.code,
        });
        applySucceeded = Boolean(applyResult?.applied);
      } catch (pendingApplyError) {
        applyError = pendingApplyError;
      }
    }

    const persistedProgress = computeBinancePendingRecordedProgress({
      exchangeFilledQty: pendingFilled,
      exchangeCost: pendingCost,
      exchangePrice: pendingPrice,
      recordedFilledQty: effectiveRecordedFilledQty,
      recordedCost: effectiveRecordedCost,
      applySucceeded: !applyError && applySucceeded,
    });
    let pendingState = null;
    try {
      pendingState = await markBinanceOrderPendingReconcileSignal(signalId, {
        symbol,
        action,
        amountUsdt,
        tradeMode: applyResult?.tradeModeUsed || signalTradeMode,
        paperMode: effectivePaperMode,
        orderMeta: {
          orderId: pendingOrder.orderId,
          clientOrderId: pendingOrder.clientOrderId || null,
          orderSymbol: pendingOrder.orderSymbol || symbol,
          submittedAtMs: pendingOrder.submittedAtMs || null,
          status: pendingOrder.status,
          amount: pendingOrder.amount,
          filled: pendingFilled,
          price: pendingPrice,
          cost: pendingCost,
          rawPrice: pendingQuoteNormalized.rawPrice,
          rawCost: pendingQuoteNormalized.rawCost,
          quoteConversionApplied: pendingQuoteNormalized.conversionApplied,
          quoteConversionRate: pendingQuoteNormalized.conversionRate,
          quoteConversionPair: pendingQuoteNormalized.conversionPair,
          quoteAsset: pendingQuoteNormalized.orderQuote,
          signalQuoteAsset: pendingQuoteNormalized.signalQuote,
          btcReferencePrice: pendingQuoteNormalized.conversionRate,
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
      await notifyError(`헤파이스토스 pending reconcile meta 저장 실패 — ${symbol} ${action}`, markError).catch(() => {});
      return {
        handled: true,
        result: {
          success: false,
          pendingReconcile: true,
          orderId: pendingOrder.orderId || null,
          clientOrderId: pendingOrder.clientOrderId || null,
          verificationStatus: pendingOrder.status,
          error: `pending_reconcile_mark_failed:${markError?.message || markError}`,
        },
      };
    }

    if (!applyError && progress.deltaFilledQty <= BINANCE_PENDING_RECONCILE_EPSILON && pendingState?.code === 'order_reconciled') {
      await syncPendingReconcileSnapshotState({
        payload,
        tradeMode: applyResult?.tradeModeUsed || signalTradeMode,
        stateCode: pendingState.code,
      }).catch(() => null);
    }

    await reconcileLivePositionsWithBrokerBalance().catch(() => []);
    console.warn(`  ⚠️ ${symbol} 주문 접수 후 체결 확정 대기 — pending reconcile 큐로 이관 (orderId=${pendingOrder.orderId || 'N/A'})`);
    return {
      handled: true,
      result: {
        success: true,
        pendingReconcile: true,
        trade: applyResult?.trade || null,
        applyFailed: Boolean(applyError),
        orderId: pendingOrder.orderId || null,
        clientOrderId: pendingOrder.clientOrderId || null,
        orderSymbol: pendingOrder.orderSymbol || symbol,
        verificationStatus: pendingOrder.status,
        error: applyError ? String(applyError?.message || applyError) : null,
      },
    };
  }

  return {
    enqueueClientOrderPendingRetry,
    handleExecutionPendingReconcileError,
  };
}

export default {
  normalizePendingReconcileTradeModes,
  buildMissingPendingReconcileKeysResult,
  buildQuoteConversionManualReconcileMeta,
  buildFetchFailurePendingReconcileMeta,
  summarizePendingReconcileResults,
  createBinanceExecutionReconcileHandler,
};
