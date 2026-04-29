// @ts-nocheck

export function createPendingSignalProcessing({
  db,
  initHubSecrets,
  getInvestmentTradeMode,
  processBinancePendingReconcileQueue,
  processBinancePendingJournalRepairQueue,
  syncPositionsAtMarketOpen,
  cleanupStalePendingSignals,
  reconcileLivePositionsWithBrokerBalance,
  executeSignal,
  delay,
} = {}) {
  async function preparePendingSignalProcessing() {
    await initHubSecrets().catch(() => false);
    const tradeMode = getInvestmentTradeMode();
    const tradeModes = Array.from(new Set([tradeMode, 'normal', 'validation'].filter(Boolean)));
    const pendingReconcileResult = await processBinancePendingReconcileQueue({
      tradeModes,
      limit: 60,
      delayMs: 120,
    }).catch((error) => {
      console.warn(`[헤파이스토스] pending reconcile 정산 실패: ${error.message}`);
      return { candidates: 0, processed: 0, summary: null, results: [] };
    });
    const pendingJournalResult = await processBinancePendingJournalRepairQueue({
      tradeModes,
      limit: 60,
      delayMs: 80,
    }).catch((error) => {
      console.warn(`[헤파이스토스] pending reconcile journal 보강 실패: ${error.message}`);
      return { candidates: 0, processed: 0, summary: null, results: [] };
    });
    const syncResult = await syncPositionsAtMarketOpen('crypto').catch((error) => ({
      ok: false,
      reason: error?.message || String(error),
      mismatchCount: 0,
      mismatches: [],
    }));
    const stalePending = [];
    for (const mode of tradeModes) {
      const rows = await cleanupStalePendingSignals({
        exchange: 'binance',
        tradeMode: mode,
      }).catch((error) => {
        console.warn(`[헤파이스토스] stale pending 정리 실패 (${mode}): ${error.message}`);
        return [];
      });
      stalePending.push(...rows);
    }
    const reconciled = await reconcileLivePositionsWithBrokerBalance().catch((error) => {
      console.warn(`[헤파이스토스] 실지갑 포지션 동기화 실패: ${error.message}`);
      return [];
    });
    if (!syncResult.skipped && !syncResult.ok) {
      console.warn(`[헤파이스토스] 브로커↔DB 포지션 복구 실패: ${syncResult.reason}`);
    }
    if (syncResult.ok && Number(syncResult.mismatchCount || 0) > 0) {
      console.log(`[헤파이스토스] 브로커↔DB 포지션 복구 ${syncResult.mismatchCount}건`);
    }
    if (stalePending.length > 0) {
      console.log(`[헤파이스토스] stale pending 정리 ${stalePending.length}건 (modes=${tradeModes.join(',')})`);
    }
    if (Number(pendingReconcileResult.processed || 0) > 0) {
      const summary = pendingReconcileResult.summary || {};
      console.log(
        `[헤파이스토스] pending reconcile ${pendingReconcileResult.processed}건 `
        + `(완료 ${Number(summary.completed || 0)} / 부분 ${Number(summary.partial || 0)} / 대기 ${Number(summary.queued || 0)} / 실패 ${Number(summary.failed || 0)})`,
      );
    }
    if (Number(pendingJournalResult.processed || 0) > 0) {
      const summary = pendingJournalResult.summary || {};
      console.log(
        `[헤파이스토스] pending journal 보강 ${pendingJournalResult.processed}건 `
        + `(복구 ${Number(summary.repaired || 0)} / 실패 ${Number(summary.failed || 0)})`,
      );
    }
    if (reconciled.length > 0) {
      console.log(`[헤파이스토스] 실지갑 포지션 동기화 ${reconciled.length}건`);
    }
    return {
      tradeMode,
      tradeModes,
      reconciled,
      stalePending,
      pendingReconcileResult,
      pendingJournalResult,
    };
  }

  async function runPendingSignalBatch(signals, { tradeMode, delayMs = 500 } = {}) {
    if (signals.length === 0) {
      console.log(`[헤파이스토스] 대기 신호 없음 (trade_mode=${tradeMode})`);
      return [];
    }

    console.log(`[헤파이스토스] ${signals.length}개 신호 처리 시작 (trade_mode=${tradeMode})`);
    const results = [];
    for (const signal of signals) {
      results.push(await executeSignal(signal));
      await delay(delayMs);
    }
    return results;
  }

  async function processAllPendingSignals() {
    const { tradeModes } = await preparePendingSignalProcessing();
    const allResults = [];
    for (const tradeMode of tradeModes) {
      const signals = await db.getApprovedSignals('binance', tradeMode);
      const results = await runPendingSignalBatch(signals, { tradeMode, delayMs: 500 });
      allResults.push(...results);
    }
    return allResults;
  }

  return {
    preparePendingSignalProcessing,
    runPendingSignalBatch,
    processAllPendingSignals,
  };
}
