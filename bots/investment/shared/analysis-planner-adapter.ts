// @ts-nocheck
import { planAnalysis } from './analysis-planner.ts';
import { buildAnalysisPlannerReport } from './analysis-planner-report.ts';

function normalizeMarketRegime(regimeSnapshot = null) {
  if (!regimeSnapshot || typeof regimeSnapshot !== 'object') return null;
  return regimeSnapshot.regime || null;
}

function normalizeAtrRatio(snapshot = null) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const value = Number(snapshot.atrRatio ?? snapshot.atr_ratio ?? snapshot.atrPct ?? snapshot.atr_pct);
  return Number.isFinite(value) ? value : null;
}

export function buildPlannerInputFromRuntime({
  regimeSnapshot = null,
  tradeMode = 'normal',
  fearGreed = null,
  volumeRatio = null,
  consecutiveLosses = 0,
  highConviction = false,
  capitalGuardTight = false,
  perceptionEnabled = null,
} = {}) {
  return {
    regime: normalizeMarketRegime(regimeSnapshot),
    atrRatio: normalizeAtrRatio(regimeSnapshot),
    tradeMode,
    fearGreed,
    volumeRatio,
    consecutiveLosses,
    highConviction,
    capitalGuardTight,
    perceptionEnabled,
  };
}

export function buildPlannerRuntimeDecision(runtime = {}) {
  const input = buildPlannerInputFromRuntime(runtime);
  const report = buildAnalysisPlannerReport(input);

  return {
    input,
    decision: planAnalysis(input),
    compact: report.compact,
    text: report.text,
  };
}

export default {
  buildPlannerInputFromRuntime,
  buildPlannerRuntimeDecision,
};
