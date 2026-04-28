// @ts-nocheck
/**
 * Phase B smoke test — strategy-validity-evaluator
 * 7 시나리오: 유효/경계/PIVOT/EXIT/mean_reversion/변동성/shadow mode
 */
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  evaluateStrategyValidity,
  VALIDITY_SMOKE_SCENARIOS,
} from '../shared/strategy-validity-evaluator.ts';

export async function runStrategyValidityEvaluatorSmoke({ json = false, enabledOverride = null } = {}) {
  const results = [];

  for (const scenario of VALIDITY_SMOKE_SCENARIOS) {
    if (enabledOverride !== null) {
      process.env.LUNA_STRATEGY_VALIDITY_EVALUATOR_ENABLED = enabledOverride ? 'true' : 'false';
    }

    const result = evaluateStrategyValidity(scenario.input);

    // shadow mode 시나리오는 action이 항상 HOLD
    const isShadowScenario = scenario.name.includes('shadow mode');
    const expectedActions = isShadowScenario
      ? ['HOLD']
      : scenario.expectedActionRange;

    const actionOk = expectedActions.includes(result.recommendedAction);
    const scoreValid = Number.isFinite(result.score) && result.score >= 0 && result.score <= 1;
    const dimensionCountOk = result.dimensions.length === 7;
    const pass = actionOk && scoreValid && dimensionCountOk;

    results.push({
      scenario: scenario.name,
      pass,
      score: result.score,
      bayesianPosterior: result.bayesianPosterior,
      action: result.recommendedAction,
      expectedActions,
      driftReasons: result.driftReasons,
      shadowMode: result.shadowMode,
      dimensions: result.dimensions.map((d) => `${d.name}:${d.score.toFixed(2)}`),
      errors: [
        !actionOk && `action 불일치: ${result.recommendedAction} ∉ [${expectedActions.join('/')}]`,
        !scoreValid && `score 비정상: ${result.score}`,
        !dimensionCountOk && `dimension 수 오류: ${result.dimensions.length} ≠ 7`,
      ].filter(Boolean),
    });
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const summary = { passed, total, pass: passed === total, results };

  if (json) return summary;

  const lines = [
    `[strategy-validity-evaluator-smoke] ${passed}/${total} 통과`,
    '',
    ...results.map((r) => {
      const icon = r.pass ? '✓' : '✗';
      const out = [
        `  ${icon} ${r.scenario}`,
        `    score: ${r.score.toFixed(3)} (Bayesian: ${r.bayesianPosterior.toFixed(3)}) → action: ${r.action}${r.shadowMode ? ' [shadow]' : ''}`,
        `    dimensions: ${r.dimensions.join(', ')}`,
      ];
      if (r.driftReasons.length > 0) {
        out.push(`    drift: ${r.driftReasons.slice(0, 2).join(' | ')}`);
      }
      if (r.errors.length > 0) out.push(`    오류: ${r.errors.join(', ')}`);
      return out.join('\n');
    }),
  ];
  return { ...summary, text: lines.join('\n') };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const args = process.argv.slice(2);
      const json = args.includes('--json');
      const enabledOverride = args.includes('--enabled') ? true : args.includes('--disabled') ? false : null;
      return runStrategyValidityEvaluatorSmoke({ json, enabledOverride });
    },
    onSuccess: async (result) => {
      if (result?.text) { console.log(result.text); return; }
      console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '[strategy-validity-evaluator-smoke]',
  });
}

export default { runStrategyValidityEvaluatorSmoke };
