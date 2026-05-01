// @ts-nocheck

import { extractExecutionTimestampMs } from '../../shared/binance-order-execution-normalizer.ts';

export function isHephaestosHotPathPrefetchEnabled(env = process.env) {
  const raw = String(env?.HEPHAESTOS_HOT_PATH_PREFETCH_ENABLED || '').trim().toLowerCase();
  if (['0', 'false', 'off', 'disabled'].includes(raw)) return false;
  return true;
}

export function createHephaestosSignalExecutor(deps = {}) {
  const {
    ACTIONS,
    SIGNAL_STATUS,
    db,
    initHubSecrets,
    isPaperMode,
    getInvestmentTradeMode,
    getCapitalConfig,
    getDynamicMinOrderAmount,
    buildHephaestosExecutionPreflight,
    buildExecutionRiskApprovalGuard,
    notifyTradeSkip,
    normalizePartialExitRatio,
    buildSignalQualityContext,
    getInvestmentAgentRoleState,
    createSignalFailurePersister,
    isBinanceSymbol,
    maybePromotePaperPositions,
    runBuySafetyGuards,
    checkCircuitBreaker,
    getOpenPositions,
    getMaxPositionsOverflowPolicy,
    getDailyTradeCount,
    formatDailyTradeLimitReason,
    tryAbsorbUntrackedBalance,
    checkBuyReentryGuards,
    _tryBuyWithBtcPair,
    shouldBlockUsdtFallbackAfterBtcPairError,
    liquidateUntrackedForCapital,
    resolveBuyExecutionMode,
    rejectExecution,
    resolveBuyOrderAmount,
    applyResponsibilityExecutionSizing,
    buildDeterministicClientOrderId,
    marketBuy,
    persistBuyPosition,
    attachExecutionToPositionStrategyTracked,
    syncCryptoStrategyExecutionState,
    applyBuyProtectiveExit,
    resolveSellExecutionContext,
    resolveSellAmount,
    executeSellTrade,
    finalizeExecutedTrade,
    binanceExecutionReconcileHandler,
    notifyError,
  } = deps;

async function executeSignal(signal) {
  const hephaestosRoleStatePromise = isHephaestosHotPathPrefetchEnabled()
    ? getInvestmentAgentRoleState('hephaestos', 'binance').catch(() => null)
    : null;

  await initHubSecrets().catch(() => false);
  const preflight = await buildHephaestosExecutionPreflight(signal, {
    globalPaperMode: isPaperMode(),
    defaultTradeMode: getInvestmentTradeMode(),
    getCapitalConfig,
    getDynamicMinOrderAmount,
  });
  const { globalPaperMode, executionContext, capitalPolicy, minOrderUsdt } = preflight;
  let { signalTradeMode } = preflight;
  const {
    signalId,
    symbol,
    action,
    amountUsdt,
    base,
    tag,
  } = executionContext;
  let { effectivePaperMode } = executionContext;

  // ★ SEC-004 가드: 네메시스 승인/실행 freshness 재검증 (BUY 전용 — SELL은 포지션 청산이므로 예외)
  if (action !== ACTIONS.SELL && !globalPaperMode) {
    const executionGuard = buildExecutionRiskApprovalGuard(signal, {
      market: 'binance',
      codePrefix: 'sec004',
      executionBlockedBy: 'hephaestos_entry_guard',
      paperMode: globalPaperMode,
    });
    if (!executionGuard.approved) {
      const reason = `SEC-004: ${executionGuard.reason}`;
      console.error(`  🛡️ [헤파이스토스] ${reason}`);
      if (signalId) {
        await db.updateSignalBlock(signalId, {
          status: SIGNAL_STATUS.FAILED,
          reason: reason.slice(0, 180),
          code: executionGuard.code,
          meta: executionGuard.meta,
        }).catch(() => {});
      }
      notifyTradeSkip({ symbol, action, reason }).catch(() => {});
      return { success: false, reason, code: executionGuard.code, riskApprovalExecution: executionGuard.meta?.risk_approval_execution || null };
    }
  }

  const exitReasonOverride = signal.exit_reason_override || null;
  const partialExitRatio = normalizePartialExitRatio(signal.partial_exit_ratio || signal.partialExitRatio);
  const qualityContext = buildSignalQualityContext(signal);
  const hephaestosRoleState = hephaestosRoleStatePromise
    ? await hephaestosRoleStatePromise
    : await getInvestmentAgentRoleState('hephaestos', 'binance').catch(() => null);
  const persistFailure = createSignalFailurePersister({
    db,
    signalId,
    symbol,
    action,
    amountUsdt,
    failedStatus: SIGNAL_STATUS.FAILED,
  });

  if (!isBinanceSymbol(symbol)) {
    const reason = `바이낸스 심볼이 아님: ${symbol}`;
    console.log(`  ⛔ [헤파이스토스] ${reason}`);
    await persistFailure(reason, {
      code: 'invalid_binance_symbol',
      meta: {
        invalidSymbol: symbol,
        tradeMode: signalTradeMode,
      },
    });
    notifyTradeSkip({ symbol, action, reason }).catch(() => {});
    return { success: false, reason };
  }

  console.log(`\n⚡ [헤파이스토스] ${symbol} ${action} $${amountUsdt} ${tag}`);

  /** @type {any} */
  let trade;
  let executionMeta = null;
  let executionClientOrderId = null;
  let executionSubmittedAtMs = null;

  try {

    if (action === ACTIONS.BUY) {
      let promoted = [];
      if (!globalPaperMode && signalTradeMode === 'normal') {
        promoted = await maybePromotePaperPositions({ reserveSlots: 1 }).catch(err => {
          console.warn(`  ⚠️ PAPER 포지션 승격 체크 실패: ${err.message}`);
          return [];
        });
        if (promoted.length > 0) {
          console.log(`  🔁 PAPER→LIVE 승격 완료: ${promoted.map(p => p.symbol).join(', ')}`);
        }
      }

      const safetyRejected = await runBuySafetyGuards({
        persistFailure,
        symbol,
        action,
        signalTradeMode,
        capitalPolicy,
        signalConfidence: Number(signal?.confidence || 0),
        checkCircuitBreaker,
        getOpenPositions,
        getMaxPositionsOverflowPolicy,
        getDailyTradeCount,
        formatDailyTradeLimitReason,
      });
      if (safetyRejected) return safetyRejected;

      const absorbed = await tryAbsorbUntrackedBalance({
        signalId,
        symbol,
        base,
        signalTradeMode,
        minOrderUsdt,
        effectivePaperMode,
      });
      if (absorbed) return absorbed;

      const buyReentryState = await checkBuyReentryGuards({
        persistFailure,
        symbol,
        action,
        signalTradeMode,
        effectivePaperMode,
      });
      if (buyReentryState?.success === false) return buyReentryState;

      // ── 미추적 BTC로 직접 매수 (BTC 페어 우선) ─────────────────────
      // 1순위: ETH/BTC 같은 직접 페어 → BTC→USDT 변환 없이 1회 수수료로 매수
      // 2순위: BTC 페어 없으면 BTC→USDT 전환 후 매수 (USDT 폴백)
      try {
        const btcResult = await _tryBuyWithBtcPair(symbol, base, signalId, signal, effectivePaperMode);
        if (btcResult) return btcResult;
      } catch (e) {
        if (shouldBlockUsdtFallbackAfterBtcPairError(e)) {
          throw e;
        }
        console.warn(`  ⚠️ BTC 직접 매수 실패 (주문 전 오류, USDT 전환 폴백): ${e.message}`);
      }

      // USDT 폴백: BTC 페어 없는 종목일 때 BTC → USDT → 매수
      try {
        const excludeBases = [
          base,
          ...promoted.map((position) => String(position.symbol || '').split('/')[0]).filter(Boolean),
        ];
        await liquidateUntrackedForCapital(excludeBases, effectivePaperMode);
      } catch (e) {
        console.warn(`  ⚠️ 미추적 코인 청산 실패 (매수 계속): ${e.message}`);
      }

      const executionModeState = await resolveBuyExecutionMode({
        persistFailure,
        signalId,
        symbol,
        action,
        amountUsdt,
        signalTradeMode,
        globalPaperMode,
        capitalPolicy,
      });
      if (executionModeState?.success === false) return executionModeState;
      effectivePaperMode = executionModeState.effectivePaperMode;
      if (executionModeState.effectiveTradeMode && executionModeState.effectiveTradeMode !== signalTradeMode) {
        signalTradeMode = executionModeState.effectiveTradeMode;
        signal.trade_mode = signalTradeMode;
      }

      const buyReentryMultiplier = Number(buyReentryState?.reducedAmountMultiplier || 1);
      const executionModeMultiplier = Number(executionModeState.reducedAmountMultiplier || 1);
      const combinedReducedAmountMultiplier = [buyReentryMultiplier, executionModeMultiplier]
        .filter((value) => value > 0 && value < 1)
        .reduce((acc, value) => acc * value, 1);
      const combinedSoftGuards = [
        ...(buyReentryState?.softGuards || []),
        ...(executionModeState.softGuards || []),
      ];
      const combinedSoftGuardApplied = Boolean(
        buyReentryState?.softGuardApplied
        || executionModeState.softGuardApplied
      );

      if (effectivePaperMode) {
        const paperPositionAfterFallback = await db.getPaperPosition(symbol, 'binance', signalTradeMode);
        if (paperPositionAfterFallback) {
          const reason = `동일 ${signalTradeMode.toUpperCase()} PAPER 포지션 보유 중 — 추가매수 차단`;
          console.log(`  ⛔ [자본관리] ${reason}`);
          return rejectExecution({
            persistFailure,
            symbol,
            action,
            reason,
            code: 'paper_position_reentry_blocked',
            meta: {
              existingPaper: paperPositionAfterFallback.paper,
              requestedPaper: effectivePaperMode,
              tradeMode: signalTradeMode,
            },
            notify: 'skip',
          });
        }
      }

      const orderAmountState = await resolveBuyOrderAmount({
        persistFailure,
        symbol,
        action,
        amountUsdt,
        signal,
        effectivePaperMode,
        reducedAmountMultiplier: combinedReducedAmountMultiplier,
        softGuards: combinedSoftGuards,
      });
      if (orderAmountState?.success === false) return orderAmountState;
      const responsibilitySizing = applyResponsibilityExecutionSizing(orderAmountState.actualAmount, {
        action,
        confidence: Number(signal?.confidence || 0),
        responsibilityPlan: signal.existingResponsibilityPlan || null,
        executionPlan: signal.existingExecutionPlan || null,
      });
      const actualAmount = responsibilitySizing.amount;
      if (!effectivePaperMode && actualAmount < minOrderUsdt) {
        return rejectExecution({
          persistFailure,
          symbol,
          action,
          reason: `책임계획 반영 후 주문금액 ${actualAmount.toFixed(2)} < 최소 ${minOrderUsdt}`,
          code: 'position_sizing_rejected',
          meta: {
            minOrderUsdt,
            responsibilityExecutionMultiplier: responsibilitySizing.multiplier,
            responsibilityExecutionReason: responsibilitySizing.reason,
          },
          notify: 'skip',
        });
      }
      executionMeta = {
        softGuardApplied: combinedSoftGuardApplied,
        softGuards: combinedSoftGuards,
        reducedAmountMultiplier: combinedReducedAmountMultiplier,
        requestedAmountUsdt: Number(amountUsdt || 0),
        actualAmountUsdt: Number(actualAmount || 0),
        responsibilityExecutionMultiplier: responsibilitySizing.multiplier,
        responsibilityExecutionReason: responsibilitySizing.reason,
        agentRole: hephaestosRoleState
          ? {
              mission: hephaestosRoleState.mission || null,
              roleMode: hephaestosRoleState.role_mode || null,
              priority: Number(hephaestosRoleState.priority || 0),
            }
          : null,
      };

      if (responsibilitySizing.reason && responsibilitySizing.multiplier !== 1) {
        console.log(`  🎛️ [execution tone] ${symbol} 책임계획 반영 x${responsibilitySizing.multiplier.toFixed(2)} (${responsibilitySizing.reason})`);
      }

      executionSubmittedAtMs = Date.now();
      executionClientOrderId = !effectivePaperMode
        ? buildDeterministicClientOrderId({
            signalId,
            symbol,
            action: action || ACTIONS.BUY,
            scope: signalTradeMode || 'main',
          })
        : null;
      const order = await marketBuy(symbol, actualAmount, effectivePaperMode, {
        clientOrderId: executionClientOrderId,
        submittedAtMs: executionSubmittedAtMs,
      });
      const settledUsdt = Number(order.cost || (Number(order.filled || 0) * Number(order.price || order.average || 0)) || actualAmount);
      trade = {
        signalId,
        symbol,
        side:      'buy',
        amount:    order.filled,
        price:     order.price,
        totalUsdt: settledUsdt,
        executedAt: extractExecutionTimestampMs(order, executionSubmittedAtMs),
        paper:     effectivePaperMode,
        exchange:  'binance',
        tradeMode: signalTradeMode,
        ...qualityContext,
      };

      await persistBuyPosition({ symbol, order, effectivePaperMode, signalTradeMode });
      if (!effectivePaperMode) {
        await attachExecutionToPositionStrategyTracked({
          trade,
          signal,
          dryRun: false,
          requireOpenPosition: true,
        }).catch((error) => {
          console.warn(`  ⚠️ ${symbol} execution attach 실패: ${error.message}`);
        });
      }
      await syncCryptoStrategyExecutionState({
        symbol,
        tradeMode: signalTradeMode,
        lifecycleStatus: 'position_open',
        recommendation: 'HOLD',
        reasonCode: 'buy_executed',
        reason: 'BUY 체결 완료',
        trade,
        executionMission: executionMeta?.agentRole?.mission || null,
        updatedBy: 'hephaestos_buy_execute',
      });
      await applyBuyProtectiveExit({ trade, signal, order, effectivePaperMode, symbol });

    } else if (action === ACTIONS.SELL) {
      const sellContext = await resolveSellExecutionContext({
        persistFailure,
        signalId,
        symbol,
        signalTradeMode,
        globalPaperMode,
      });
      if (sellContext?.success === false) return sellContext;

      const sellAmountState = await resolveSellAmount({
        persistFailure,
        signalId,
        symbol,
        signalTradeMode,
        sellPaperMode: sellContext.sellPaperMode,
        livePosition: sellContext.livePosition,
        fallbackLivePosition: sellContext.fallbackLivePosition,
        paperPosition: sellContext.paperPosition,
        position: sellContext.position,
        freeBalance: sellContext.freeBalance,
        totalBalance: sellContext.totalBalance,
        partialExitRatio,
      });
      if (sellAmountState?.success === false) return sellAmountState;

      trade = await executeSellTrade({
        signalId,
        symbol,
        amount: sellAmountState.amount,
        sellPaperMode: sellContext.sellPaperMode,
        effectivePositionTradeMode: sellContext.effectivePositionTradeMode,
        position: sellContext.position,
        sourcePositionAmount: sellAmountState.sourcePositionAmount,
        partialExitRatio: sellAmountState.partialExitRatio,
        qualityContext,
      });

    } else {
      console.log(`  ⏸️ HOLD — 실행 없음`);
      await db.updateSignalStatus(signalId, SIGNAL_STATUS.EXECUTED);
      return { success: true };
    }

    await finalizeExecutedTrade({
      trade,
      signalId,
      signalTradeMode,
      capitalPolicy,
      exitReason: exitReasonOverride,
      executionMeta,
      hephaestosRoleState,
    });

    const doneTag = trade.paper ? '[PAPER]' : '[LIVE]';
    console.log(`  ✅ ${doneTag} 완료: ${trade.side} ${trade.amount?.toFixed(6)} @ $${trade.price?.toLocaleString()}`);
    return { success: true, trade };

  } catch (e) {
    const pendingHandling = await binanceExecutionReconcileHandler.handleExecutionPendingReconcileError({
      error: e,
      signal,
      signalId,
      symbol,
      action,
      amountUsdt,
      signalTradeMode,
      effectivePaperMode,
      persistFailure,
      executionClientOrderId,
      executionSubmittedAtMs,
    });
    if (pendingHandling?.handled) {
      return pendingHandling.result;
    }
    const pendingSourceError = pendingHandling?.error || e;
    console.error(`  ❌ 실행 오류: ${pendingSourceError.message}`);
    const failureCode = pendingSourceError?.code === 'sell_amount_below_minimum'
      ? 'sell_amount_below_minimum'
      : 'broker_execution_error';
    await persistFailure(pendingSourceError.message, {
      code: failureCode,
      meta: {
        error: String(pendingSourceError.message).slice(0, 240),
        ...(pendingSourceError?.meta || {}),
      },
    });
    await notifyError(`헤파이스토스 - ${symbol} ${action}`, pendingSourceError);
    return { success: false, error: pendingSourceError.message };
  }
}

  return { executeSignal };
}
