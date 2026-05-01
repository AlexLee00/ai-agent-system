// @ts-nocheck
/**
 * Behavior-preserving signal context normalizer for Hephaestos execution.
 *
 * This is intentionally tiny: it extracts the stable shape from executeSignal
 * without moving order placement or guard semantics yet.
 */

export function buildHephaestosExecutionContext(signal = {}, {
  globalPaperMode = false,
  defaultTradeMode = 'normal',
} = {}) {
  const signalId = signal.id;
  const symbol = signal.symbol;
  const action = signal.action;
  const rawAmountUsdt = signal.amountUsdt ?? signal.amount_usdt;
  const amountUsdt = rawAmountUsdt ?? 100;
  const signalTradeMode = signal.trade_mode || defaultTradeMode;
  const base = String(symbol || '').split('/')[0];
  const effectivePaperMode = globalPaperMode;
  return {
    signalId,
    symbol,
    action,
    amountUsdt,
    signalTradeMode,
    base,
    effectivePaperMode,
    tag: effectivePaperMode ? '[PAPER]' : '[LIVE]',
  };
}

export default {
  buildHephaestosExecutionContext,
};
