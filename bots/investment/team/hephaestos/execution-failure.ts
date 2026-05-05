// @ts-nocheck

/**
 * Failure persistence/notification helpers for Hephaestos execution.
 *
 * The execution bot still owns trading behavior; this module removes repeated
 * failure wiring from the hot function while preserving the exact block meta
 * contract used by downstream reconcile and learning jobs.
 */

import { notifyCircuitBreaker, notifyTradeSkip } from '../../shared/report.ts';
import { resolveExpectedSellNoopStatus } from '../../shared/trade-data-derived-guards.ts';

export function createSignalFailurePersister({
  db,
  signalId,
  symbol,
  action,
  amountUsdt,
  failedStatus,
  exchange = 'binance',
}) {
  return async function persistFailure(reason, {
    code = 'broker_execution_error',
    meta = {},
    status = null,
  } = {}) {
    const noop = resolveExpectedSellNoopStatus({ action, code, status });
    await db.updateSignalBlock(signalId, {
      status: noop.status || failedStatus,
      reason: reason ? String(reason).slice(0, 180) : null,
      code,
      meta: {
        exchange,
        symbol,
        action,
        amount: amountUsdt,
        ...(noop.classification ? {
          executionNoop: {
            classification: noop.classification,
            source: 'trade_data_sell_hygiene',
          },
        } : {}),
        ...meta,
      },
    }).catch(() => {});
  };
}

export async function rejectExecution({
  persistFailure,
  symbol,
  action,
  reason,
  code = 'broker_execution_error',
  meta = {},
  notify = 'skip',
}) {
  await persistFailure(reason, { code, meta });
  if (notify === 'circuit') {
    notifyCircuitBreaker({ reason, type: meta.circuitType ?? null }).catch(() => {});
  } else if (notify === 'skip') {
    notifyTradeSkip({
      symbol,
      action,
      reason,
      openPositions: meta.openPositions,
      maxPositions: meta.maxPositions,
    }).catch(() => {});
  }
  // notify === 'digest': capital_backpressure 계열은 즉시 알림 없이 DB 기록만
  return { success: false, reason };
}

export default {
  createSignalFailurePersister,
  rejectExecution,
};
