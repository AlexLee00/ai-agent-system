// @ts-nocheck
import { buildAnalysisPlannerReport } from './analysis-planner-report.ts';

const DEFAULT_SCENARIOS = [
  {
    name: 'baseline_ranging',
    input: {
      regime: 'ranging',
      atrRatio: 0.02,
      tradeMode: 'normal',
      fearGreed: 50,
      volumeRatio: 0.9,
      consecutiveLosses: 0,
    },
  },
  {
    name: 'volatile_high_conviction',
    input: {
      regime: 'volatile',
      atrRatio: 0.05,
      tradeMode: 'normal',
      highConviction: true,
      fearGreed: 42,
      volumeRatio: 1.2,
      consecutiveLosses: 0,
    },
  },
  {
    name: 'validation_capital_guard',
    input: {
      regime: 'trending_bear',
      atrRatio: 0.03,
      tradeMode: 'validation',
      capitalGuardTight: true,
      fearGreed: 28,
      volumeRatio: 0.7,
      consecutiveLosses: 1,
    },
  },
  {
    name: 'perception_skip_fear_greed',
    input: {
      regime: 'trending_bull',
      atrRatio: 0.018,
      tradeMode: 'normal',
      fearGreed: 90,
      volumeRatio: 0.8,
      consecutiveLosses: 0,
      perceptionEnabled: true,
    },
  },
];

export function runAnalysisPlannerScenarios(scenarios = DEFAULT_SCENARIOS) {
  return scenarios.map((scenario) => {
    const report = buildAnalysisPlannerReport(scenario.input || {});
    return {
      name: scenario.name,
      input: scenario.input || {},
      compact: report.compact,
      text: report.text,
    };
  });
}

export function summarizeAnalysisPlannerScenarios(scenarios = DEFAULT_SCENARIOS) {
  const results = runAnalysisPlannerScenarios(scenarios);
  const passed = results.filter((item) => item.compact.shouldAnalyze).length;
  const skipped = results.length - passed;

  return {
    total: results.length,
    analyzeCount: passed,
    skipCount: skipped,
    results,
  };
}

export function renderAnalysisPlannerScenarioSummary(scenarios = DEFAULT_SCENARIOS) {
  const summary = summarizeAnalysisPlannerScenarios(scenarios);
  const lines = [
    `Analysis planner scenarios: ${summary.total}`,
    `analyze: ${summary.analyzeCount}`,
    `skip: ${summary.skipCount}`,
  ];

  for (const item of summary.results) {
    lines.push(
      `${item.name} | mode=${item.compact.mode} | depth=${item.compact.researchDepth} | shouldAnalyze=${item.compact.shouldAnalyze ? 'yes' : 'no'}${item.compact.skipReason ? ` | skipReason=${item.compact.skipReason}` : ''}`,
    );
  }

  return lines.join('\n');
}

export default {
  runAnalysisPlannerScenarios,
  summarizeAnalysisPlannerScenarios,
  renderAnalysisPlannerScenarioSummary,
};
