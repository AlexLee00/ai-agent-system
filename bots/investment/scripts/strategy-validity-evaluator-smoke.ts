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
import { assertSmokePass } from '../shared/smoke-assert.ts';

export async function runStrategyValidityEvaluatorSmoke({ json = false, enabledOverride = null, strict = true } = {}) {
  const results = [];
  const modes = enabledOverride === null ? [false, true] : [enabledOverride === true];

  for (const enabled of modes) {
    process.env.LUNA_STRATEGY_VALIDITY_EVALUATOR_ENABLED = enabled ? 'true' : 'false';
    for (const scenario of VALIDITY_SMOKE_SCENARIOS) {
      const isShadowScenario = scenario.name.includes('shadow mode');
      if (enabled && isShadowScenario) continue;

      const result = evaluateStrategyValidity(scenario.input);

      const expectedActions = enabled ? scenario.expectedActionRange : ['HOLD'];

      const actionOk = expectedActions.includes(result.recommendedAction);
      const scoreValid = Number.isFinite(result.score) && result.score >= 0 && result.score <= 1;
      const dimensionCountOk = result.dimensions.length === 7;
      const pass = actionOk && scoreValid && dimensionCountOk;

      results.push({
        mode: enabled ? 'enabled' : 'shadow',
        scenario: scenario.name,
        pass,
        score: result.score,
        actionScore: result.actionScore,
        weightedScore: result.weightedScore,
        baseAction: result.baseAction,
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
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const summary = { passed, total, pass: passed === total, results };
  if (strict) assertSmokePass(summary, '[strategy-validity-evaluator-smoke]');

  if (json) return summary;

  const lines = [
    `[strategy-validity-evaluator-smoke] ${passed}/${total} 통과`,
    '',
    ...results.map((r) => {
      const icon = r.pass ? '✓' : '✗';
      const out = [
        `  ${icon} [${r.mode}] ${r.scenario}`,
        `    score: ${r.score.toFixed(3)} (actionScore: ${Number(r.actionScore ?? r.score).toFixed(3)}, Bayesian: ${r.bayesianPosterior.toFixed(3)}, base: ${r.baseAction || 'n/a'}) → action: ${r.action}${r.shadowMode ? ' [shadow]' : ''}`,
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
      return runStrategyValidityEvaluatorSmoke({ json, enabledOverride, strict: true });
    },
    onSuccess: async (result) => {
      if (result?.text) { console.log(result.text); return; }
      console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '[strategy-validity-evaluator-smoke]',
  });
}

export default { runStrategyValidityEvaluatorSmoke };
