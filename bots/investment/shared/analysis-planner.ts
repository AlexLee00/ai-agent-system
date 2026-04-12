// @ts-nocheck
import { resolveResearchDepth } from './research-depth.ts';
import { shouldAnalyzeWithPerception } from './perception-first.ts';

export function planAnalysis({
  regime = null,
  atrRatio = null,
  tradeMode = 'normal',
  highConviction = false,
  capitalGuardTight = false,
  fearGreed = null,
  volumeRatio = null,
  consecutiveLosses = 0,
  perceptionEnabled = null,
} = {}) {
  const perception = shouldAnalyzeWithPerception({
    fearGreed,
    volumeRatio,
    consecutiveLosses,
    enabled: perceptionEnabled,
  });

  const depth = resolveResearchDepth({
    regime,
    atrRatio,
    tradeMode,
    highConviction,
    capitalGuardTight,
  });

  return {
    shouldAnalyze: perception.shouldAnalyze,
    skipReason: perception.shouldAnalyze ? null : perception.reason,
    signals: perception.signals,
    researchDepth: depth,
    plan: buildPlanSummary({
      shouldAnalyze: perception.shouldAnalyze,
      skipReason: perception.reason,
      depth,
      signalCount: perception.signals.length,
    }),
  };
}

function buildPlanSummary({ shouldAnalyze, skipReason, depth, signalCount }) {
  if (!shouldAnalyze) {
    return {
      mode: 'skip',
      headline: `skip analysis (${skipReason})`,
      detail: `perception filter blocked analysis with ${signalCount} signal(s)`,
    };
  }

  return {
    mode: 'analyze',
    headline: `run depth ${depth} analysis`,
    detail: `research depth ${depth} selected for current market inputs`,
  };
}
