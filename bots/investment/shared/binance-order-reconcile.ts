// @ts-nocheck
/**
 * Binance order reconciliation facade.
 *
 * Hephaestos still owns the high-risk execution flow, but the queue/unit
 * reconciliation primitives are grouped here so future module splits have a
 * single import seam instead of reaching into multiple low-level files.
 */

export {
  isPendingReconcileQuoteConversionError,
  normalizePendingReconcileOrderUnits,
} from './binance-pending-reconcile-units.ts';

export {
  computeBinancePendingRecordedProgress,
  buildBinancePendingReconcilePayload,
  BINANCE_PENDING_RECONCILE_EPSILON,
  resolveBinancePendingQueueState,
} from './binance-pending-reconcile-queue.ts';
