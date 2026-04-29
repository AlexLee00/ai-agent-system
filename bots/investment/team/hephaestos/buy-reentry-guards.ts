// @ts-nocheck

export function createBuyReentryGuardPolicy({
  db,
  findAnyLivePosition,
  isSameDaySymbolReentryBlockEnabled,
  getValidationLiveReentrySofteningPolicy,
  rejectExecution,
  buildGuardTelemetryMeta,
} = {}) {
  async function checkBuyReentryGuards({
    persistFailure,
    symbol,
    action,
    signalTradeMode,
    effectivePaperMode,
  }) {
    const [livePosition, paperPosition, sameDayBuyTrade] = await Promise.all([
      db.getLivePosition(symbol, 'binance', signalTradeMode),
      db.getPaperPosition(symbol, 'binance', signalTradeMode),
      isSameDaySymbolReentryBlockEnabled()
        ? db.getSameDayTrade({ symbol, side: 'buy', exchange: 'binance', tradeMode: signalTradeMode })
        : Promise.resolve(null),
    ]);
    const fallbackLivePosition = !livePosition
      ? await findAnyLivePosition(symbol, 'binance').catch(() => null)
      : null;

    if (effectivePaperMode && livePosition) {
      const reason = '실포지션 보유 중에는 PAPER 추가매수로 혼합 포지션을 만들 수 없음';
      console.log(`  ⛔ [자본관리] ${reason}`);
      return rejectExecution({
        persistFailure,
        symbol,
        action,
        reason,
        code: 'position_mode_conflict',
        meta: {
          existingPaper: livePosition.paper,
          requestedPaper: effectivePaperMode,
        },
        notify: 'skip',
      });
    }
    if (effectivePaperMode && paperPosition) {
      const reason = `동일 ${signalTradeMode.toUpperCase()} PAPER 포지션 보유 중 — 추가매수 차단`;
      console.log(`  ⛔ [자본관리] ${reason}`);
      return rejectExecution({
        persistFailure,
        symbol,
        action,
        reason,
        code: 'paper_position_reentry_blocked',
        meta: {
          existingPaper: paperPosition.paper,
          requestedPaper: effectivePaperMode,
          tradeMode: signalTradeMode,
        },
        notify: 'skip',
      });
    }
    if (!effectivePaperMode && livePosition) {
      const validationLiveReentrySoftening = getValidationLiveReentrySofteningPolicy();
      const reentryReductionMultiplier = Number(validationLiveReentrySoftening?.reductionMultiplier || 0);
      if (
        signalTradeMode === 'validation'
        && validationLiveReentrySoftening?.enabled !== false
        && reentryReductionMultiplier > 0
        && reentryReductionMultiplier < 1
      ) {
        console.log(
          `  ⚖️ [가드 완화] ${symbol} validation 기존 LIVE 포지션 존재 → 감산 허용 x${reentryReductionMultiplier.toFixed(2)}`
        );
        return {
          livePosition,
          fallbackLivePosition,
          paperPosition,
          softGuardApplied: true,
          reducedAmountMultiplier: reentryReductionMultiplier,
          softGuards: [
            {
              kind: 'validation_live_reentry_softened',
              exchange: 'binance',
              tradeMode: signalTradeMode,
              reductionMultiplier: reentryReductionMultiplier,
              originReason: '동일 LIVE 포지션 보유 중 — validation 추가매수 감산 허용',
            },
          ],
        };
      }
      const reason = '동일 LIVE 포지션 보유 중 — 추가매수 차단';
      console.log(`  ⛔ [자본관리] ${reason}`);
      return rejectExecution({
        persistFailure,
        symbol,
        action,
        reason,
        code: 'live_position_reentry_blocked',
        meta: buildGuardTelemetryMeta(symbol, action, signalTradeMode, {
          existingPaper: livePosition.paper,
          requestedPaper: effectivePaperMode,
        }, {
          guardKind: 'validation_live_overlap',
          pressureSource: 'live_position_overlap',
        }),
        notify: 'skip',
      });
    }
    if (!livePosition && !paperPosition && sameDayBuyTrade) {
      const reason = `동일 ${signalTradeMode.toUpperCase()} 심볼 당일 재진입 차단`;
      console.log(`  ⛔ [자본관리] ${reason}`);
      return rejectExecution({
        persistFailure,
        symbol,
        action,
        reason,
        code: 'same_day_reentry_blocked',
        meta: {
          tradeMode: signalTradeMode,
          sameDayTradeId: sameDayBuyTrade.id,
          sameDayTradePaper: sameDayBuyTrade.paper === true,
        },
        notify: 'skip',
      });
    }

    return { livePosition, fallbackLivePosition, paperPosition };
  }

  return { checkBuyReentryGuards };
}
