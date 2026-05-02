// @ts-nocheck

const DEFAULT_PENDING_SIGNAL_CONCURRENCY = 1;
const MAX_PENDING_SIGNAL_CONCURRENCY = 4;
const DEFAULT_PENDING_SIGNAL_DELAY_MS = 500;
const MIN_PENDING_SIGNAL_DELAY_MS = 50;
const MAX_PENDING_TRADE_MODE_CONCURRENCY = 2;

export function getPendingSignalConcurrency(env = process.env) {
  const raw = Number(
    env?.HEPHAESTOS_PENDING_SIGNAL_CONCURRENCY
    || env?.LUNA_PENDING_SIGNAL_CONCURRENCY
    || DEFAULT_PENDING_SIGNAL_CONCURRENCY,
  );
  if (!Number.isFinite(raw) || raw < 2) return DEFAULT_PENDING_SIGNAL_CONCURRENCY;
  return Math.min(MAX_PENDING_SIGNAL_CONCURRENCY, Math.floor(raw));
}

export function getPendingSignalDelayMs(env = process.env) {
  const raw = Number(
    env?.HEPHAESTOS_PENDING_SIGNAL_DELAY_MS
    || env?.LUNA_PENDING_SIGNAL_DELAY_MS
    || DEFAULT_PENDING_SIGNAL_DELAY_MS,
  );
  if (!Number.isFinite(raw)) return DEFAULT_PENDING_SIGNAL_DELAY_MS;
  return Math.max(MIN_PENDING_SIGNAL_DELAY_MS, Math.floor(raw));
}

export function getPendingTradeModeQueueConcurrency(env = process.env) {
  const raw = Number(
    env?.HEPHAESTOS_PENDING_TRADE_MODE_QUEUE_CONCURRENCY
    || env?.LUNA_PENDING_TRADE_MODE_QUEUE_CONCURRENCY
    || 1,
  );
  if (!Number.isFinite(raw) || raw < 2) return 1;
  return Math.min(MAX_PENDING_TRADE_MODE_CONCURRENCY, Math.floor(raw));
}

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
  function resolveSignalFetcher(methodName) {
    if (db && typeof db[methodName] === 'function') return db[methodName].bind(db);
    return null;
  }

  async function listHephaestosExecutableSignals(tradeMode) {
    const pendingFetcher = resolveSignalFetcher('getPendingSignals');
    const approvedFetcher = resolveSignalFetcher('getApprovedSignals');
    if (!pendingFetcher && !approvedFetcher) {
      throw new TypeError('hephaestos pending signal processing requires getPendingSignals or getApprovedSignals');
    }
    const [pendingSignals, approvedSignals] = await Promise.all([
      pendingFetcher ? pendingFetcher('binance', tradeMode) : [],
      approvedFetcher ? approvedFetcher('binance', tradeMode) : [],
    ]);
    const signalsById = new Map();
    for (const signal of [...pendingSignals, ...approvedSignals]) {
      signalsById.set(signal.id, signal);
    }
    const signals = [...signalsById.values()].sort((a, b) => {
      const aTime = new Date(a.created_at || 0).getTime();
      const bTime = new Date(b.created_at || 0).getTime();
      return aTime - bTime;
    });
    return {
      signals,
      pendingCount: pendingSignals.length,
      approvedCount: approvedSignals.length,
    };
  }

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
    const stalePendingResults = await Promise.all(tradeModes.map(async (mode) => {
      const rows = await cleanupStalePendingSignals({
        exchange: 'binance',
        tradeMode: mode,
      }).catch((error) => {
        console.warn(`[헤파이스토스] stale pending 정리 실패 (${mode}): ${error.message}`);
        return [];
      });
      return rows;
    }));
    const stalePending = stalePendingResults.flat();
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

  async function runSequentialPendingSignalBatch(signals, delayMs) {
    const results = [];
    for (const signal of signals) {
      results.push(await executeSignal(signal));
      await delay(delayMs);
    }
    return results;
  }

  async function runConcurrentPendingSignalBatch(signals, { delayMs, concurrency }) {
    const results = new Array(signals.length);
    let nextIndex = 0;

    async function worker() {
      while (nextIndex < signals.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await executeSignal(signals[currentIndex]);
        await delay(delayMs);
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, signals.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  async function runPendingSignalBatch(signals, { tradeMode, delayMs = getPendingSignalDelayMs(), concurrency = getPendingSignalConcurrency() } = {}) {
    if (signals.length === 0) {
      console.log(`[헤파이스토스] 대기 신호 없음 (trade_mode=${tradeMode})`);
      return [];
    }

    const effectiveConcurrency = Math.max(1, Math.min(Number(concurrency || 1), signals.length));
    const concurrencySuffix = effectiveConcurrency > 1 ? `, concurrency=${effectiveConcurrency}` : '';
    console.log(`[헤파이스토스] ${signals.length}개 신호 처리 시작 (trade_mode=${tradeMode}${concurrencySuffix})`);
    if (effectiveConcurrency <= 1) {
      return runSequentialPendingSignalBatch(signals, delayMs);
    }
    return runConcurrentPendingSignalBatch(signals, {
      delayMs,
      concurrency: effectiveConcurrency,
    });
  }

  async function processAllPendingSignals() {
    const { tradeModes } = await preparePendingSignalProcessing();
    const allResults = [];
    const tradeModeConcurrency = Math.max(1, Math.min(getPendingTradeModeQueueConcurrency(), tradeModes.length));
    let nextModeIndex = 0;

    async function worker() {
      while (nextModeIndex < tradeModes.length) {
        const tradeMode = tradeModes[nextModeIndex];
        nextModeIndex += 1;
        const {
          signals,
          pendingCount,
          approvedCount,
        } = await listHephaestosExecutableSignals(tradeMode);
        if (signals.length > 0) {
          console.log(
            `[헤파이스토스] 실행대상 복구 ${signals.length}건 `
            + `(pending=${pendingCount}, approved=${approvedCount}, trade_mode=${tradeMode})`,
          );
        }
        const results = await runPendingSignalBatch(signals, {
          tradeMode,
          delayMs: getPendingSignalDelayMs(),
        });
        allResults.push(...results);
      }
    }
    await Promise.all(Array.from({ length: tradeModeConcurrency }, () => worker()));
    return allResults;
  }

  return {
    preparePendingSignalProcessing,
    listHephaestosExecutableSignals,
    runPendingSignalBatch,
    processAllPendingSignals,
  };
}
