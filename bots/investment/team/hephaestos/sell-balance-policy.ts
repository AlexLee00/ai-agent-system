// @ts-nocheck
/**
 * Pure balance policy for Binance SELL sizing.
 *
 * Binance free balance can be lower than total balance when TP/SL protective
 * orders are locking the asset. Treat that as a locked-balance condition, not
 * as a position/journal quantity drift.
 */

const SELL_BALANCE_EPSILON = 1e-8;

function safeNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

export function buildSellBalancePolicy({
  sourceAmount = 0,
  freeBalance = 0,
  totalBalance = 0,
  partialExitRatio = 1,
  sellPaperMode = false,
} = {}) {
  const source = Math.max(0, safeNumber(sourceAmount));
  const free = Math.max(0, safeNumber(freeBalance));
  const total = Math.max(0, safeNumber(totalBalance, free));
  const ratio = Math.max(0, Math.min(1, safeNumber(partialExitRatio, 1)));
  const intendedSellAmount = ratio < 1 ? source * ratio : source;
  const tolerance = Math.max(SELL_BALANCE_EPSILON, intendedSellAmount * 0.001);

  const freeShort = !sellPaperMode && free + tolerance < intendedSellAmount;
  const totalCoversIntended = !sellPaperMode && total + tolerance >= intendedSellAmount;
  const totalBelowSource = !sellPaperMode && total + tolerance < source;
  const lockedByOpenOrders = freeShort && totalCoversIntended;
  const truePositionDrift = freeShort && !totalCoversIntended && totalBelowSource;

  return {
    sourceAmount: source,
    intendedSellAmount,
    freeBalance: free,
    totalBalance: total,
    lockedBalance: Math.max(0, total - free),
    partialExitRatio: ratio,
    freeShort,
    totalCoversIntended,
    lockedByOpenOrders,
    truePositionDrift,
    reconcileTrackedAmount: truePositionDrift ? total : null,
  };
}

export default {
  buildSellBalancePolicy,
};
