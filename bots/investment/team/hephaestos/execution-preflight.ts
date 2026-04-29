// @ts-nocheck

import { buildHephaestosExecutionContext } from './execution-context.ts';

/**
 * Build the stable preflight values needed before Hephaestos places an order.
 * External dependencies are injected so this helper stays behavior-preserving
 * and does not create additional exchange/runtime side effects.
 */
export async function buildHephaestosExecutionPreflight(signal = {}, {
  globalPaperMode = false,
  defaultTradeMode = 'normal',
  getCapitalConfig,
  getDynamicMinOrderAmount,
} = {}) {
  const executionContext = buildHephaestosExecutionContext(signal, {
    globalPaperMode,
    defaultTradeMode,
  });
  const signalTradeMode = executionContext.signalTradeMode;
  const capitalPolicy = typeof getCapitalConfig === 'function'
    ? getCapitalConfig('binance', signalTradeMode)
    : null;
  const minOrderUsdt = typeof getDynamicMinOrderAmount === 'function'
    ? await getDynamicMinOrderAmount('binance', signalTradeMode)
    : null;

  return {
    globalPaperMode,
    executionContext,
    signalTradeMode,
    capitalPolicy,
    minOrderUsdt,
  };
}

export default {
  buildHephaestosExecutionPreflight,
};
