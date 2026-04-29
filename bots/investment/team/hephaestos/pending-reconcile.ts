// @ts-nocheck
/**
 * Compatibility submodule for Binance pending-reconcile operations.
 *
 * The heavy mutating implementation remains in ../hephaestos.ts for this P0
 * tranche. New imports should target this module so a later physical move can
 * happen without touching callers again.
 */

import {
  buildBinancePendingReconcilePayload,
  processBinancePendingReconcileQueue,
} from '../hephaestos.ts';

export {
  buildBinancePendingReconcilePayload,
  processBinancePendingReconcileQueue,
};

export default {
  buildBinancePendingReconcilePayload,
  processBinancePendingReconcileQueue,
};
