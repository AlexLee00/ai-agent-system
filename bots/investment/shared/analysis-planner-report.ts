// @ts-nocheck
import { planAnalysis } from './analysis-planner.ts';

export function buildAnalysisPlannerReport(input = {}) {
  const result = planAnalysis(input);

  return {
    ...result,
    compact: {
      mode: result.plan.mode,
      shouldAnalyze: result.shouldAnalyze,
      researchDepth: result.researchDepth,
      skipReason: result.skipReason,
      signalCount: result.signals.length,
    },
    text: renderAnalysisPlannerReport(result),
  };
}

export function renderAnalysisPlannerReport(result) {
  const lines = [
    `mode: ${result.plan.mode}`,
    `shouldAnalyze: ${result.shouldAnalyze ? 'yes' : 'no'}`,
    `researchDepth: ${result.researchDepth}`,
    `headline: ${result.plan.headline}`,
    `detail: ${result.plan.detail}`,
  ];

  if (result.skipReason) {
    lines.push(`skipReason: ${result.skipReason}`);
  }

  if (result.signals.length > 0) {
    lines.push(`signals: ${result.signals.map((item) => item.type).join(', ')}`);
  }

  return lines.join('\n');
}
