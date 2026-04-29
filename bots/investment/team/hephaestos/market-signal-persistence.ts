// @ts-nocheck
/**
 * Signal persistence policies for Hephaestos.
 *
 * Keeps signal quality metadata and stale-pending cleanup separate from the
 * exchange execution path.
 */

export function createMarketSignalPersistence(context = {}) {
  const {
    SIGNAL_STATUS,
    db,
    getInvestmentExecutionRuntimeConfig,
  } = context;

  function buildSignalQualityContext(signal = null) {
    const isReconciledExecution = signal?.block_code === 'position_balance_reconciled';
    const baseExecutionOrigin = signal?.execution_origin || signal?.executionOrigin || 'strategy';
    const baseQualityFlag = signal?.quality_flag || signal?.qualityFlag || 'trusted';
    const baseExclude = Boolean(signal?.exclude_from_learning ?? signal?.excludeFromLearning ?? false);
    const baseIncident = signal?.incident_link || signal?.incidentLink || null;

    return {
      executionOrigin: isReconciledExecution ? 'reconciliation' : baseExecutionOrigin,
      qualityFlag: isReconciledExecution
        ? (baseQualityFlag === 'exclude_from_learning' ? baseQualityFlag : 'degraded')
        : baseQualityFlag,
      excludeFromLearning: isReconciledExecution ? true : baseExclude,
      incidentLink: isReconciledExecution ? (baseIncident || 'position_balance_reconciled') : baseIncident,
    };
  }

  async function cleanupStalePendingSignals({
    exchange = 'binance',
    tradeMode = 'normal',
  } = {}) {
    const executionConfig = getInvestmentExecutionRuntimeConfig();
    const stalePendingMinutes = Number(executionConfig?.pendingQueue?.stalePendingMinutes ?? 30);
    const safeMinutes = Number.isFinite(stalePendingMinutes) && stalePendingMinutes > 0
      ? Math.round(stalePendingMinutes)
      : 30;

    const staleRows = await db.query(
      `SELECT id, symbol, action, created_at, confidence, amount_usdt
         FROM signals
        WHERE exchange = $1
          AND status = 'pending'
          AND COALESCE(trade_mode, 'normal') = $2
          AND COALESCE(nemesis_verdict, '') = ''
          AND created_at < now() - make_interval(mins => $3)
        ORDER BY created_at ASC`,
      [exchange, tradeMode, safeMinutes],
    );

    for (const row of staleRows) {
      const ageMinutes = Math.max(0, Math.round((Date.now() - new Date(row.created_at).getTime()) / 60000));
      await db.updateSignalBlock(row.id, {
        status: SIGNAL_STATUS.FAILED,
        reason: `nemesis verdict 없이 ${ageMinutes}분 경과 (stale pending)`,
        code: 'stale_pending_signal',
        meta: {
          exchange,
          symbol: row.symbol,
          action: row.action,
          tradeMode,
          stalePendingMinutes: safeMinutes,
          ageMinutes,
          confidence: Number(row.confidence || 0),
          amountUsdt: Number(row.amount_usdt || 0),
          execution_blocked_by: 'approval_gate',
        },
      });
    }

    return staleRows;
  }

  return {
    buildSignalQualityContext,
    cleanupStalePendingSignals,
  };
}

export default {
  createMarketSignalPersistence,
};
