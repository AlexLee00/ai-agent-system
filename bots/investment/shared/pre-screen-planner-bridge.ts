// @ts-nocheck
import { getTimeMode } from './time-mode.ts';
import { buildPlannerRuntimeDecision } from './analysis-planner-adapter.ts';

function inferTradeMode({ market = 'binance', researchOnly = false } = {}) {
  if (researchOnly) return 'validation';
  if (market === 'binance') return 'normal';
  return 'normal';
}

export function buildPreScreenPlannerContext({
  market = 'binance',
  regimeSnapshot = null,
  runtimeSignals = {},
  researchOnly = false,
  tradeMode = null,
} = {}) {
  const resolvedTradeMode = tradeMode || inferTradeMode({ market, researchOnly });
  const timeMode = getTimeMode();

  return {
    market,
    timeMode,
    tradeMode: resolvedTradeMode,
    researchOnly: Boolean(researchOnly),
    planner: buildPlannerRuntimeDecision({
      regimeSnapshot,
      tradeMode: resolvedTradeMode,
      fearGreed: runtimeSignals.fearGreed ?? null,
      volumeRatio: runtimeSignals.volumeRatio ?? null,
      consecutiveLosses: runtimeSignals.consecutiveLosses ?? 0,
      highConviction: Boolean(runtimeSignals.highConviction),
      capitalGuardTight: Boolean(runtimeSignals.capitalGuardTight),
      perceptionEnabled: runtimeSignals.perceptionEnabled ?? null,
    }),
  };
}

export default {
  buildPreScreenPlannerContext,
};
