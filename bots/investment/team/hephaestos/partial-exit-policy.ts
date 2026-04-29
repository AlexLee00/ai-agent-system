// @ts-nocheck

export function normalizePartialExitRatio(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  if (parsed >= 1) return 1;
  return Number(parsed.toFixed(4));
}

export function isEffectivePartialExit({
  entrySize = 0,
  soldAmount = 0,
  partialExitRatio = null,
}) {
  const normalizedEntrySize = Number(entrySize || 0);
  const normalizedSoldAmount = Math.max(0, Number(soldAmount || 0));
  const normalizedRatio = normalizePartialExitRatio(partialExitRatio);
  const remainingSize = Math.max(0, normalizedEntrySize - normalizedSoldAmount);
  return normalizedEntrySize > 0
    && remainingSize > 0.00000001
    && (
      normalizedRatio < 1
      || normalizedSoldAmount < (normalizedEntrySize - 0.00000001)
    );
}
