// @ts-nocheck
/**
 * Phase C smoke test — strategy-mutation-engine
 * 5 시나리오: 4 mutation + 1 검증 실패 (predictive score 미달)
 * DB 접근 없이 결과 구조만 검증 (dry-run mode)
 */
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  evaluateStrategyMutation,
  MUTATION_SMOKE_SCENARIOS,
} from '../shared/strategy-mutation-engine.ts';
import { assertSmokePass } from '../shared/smoke-assert.ts';
import * as db from '../shared/db.ts';

async function runMutationWithMode(input, enabled) {
  const savedEnv = process.env.LUNA_STRATEGY_MUTATION_ENABLED;
  process.env.LUNA_STRATEGY_MUTATION_ENABLED = enabled ? 'true' : 'false';
  try {
    return await evaluateStrategyMutation(input);
  } finally {
    if (savedEnv === undefined) {
      delete process.env.LUNA_STRATEGY_MUTATION_ENABLED;
    } else {
      process.env.LUNA_STRATEGY_MUTATION_ENABLED = savedEnv;
    }
  }
}

export async function runStrategyMutationEngineSmoke({ json = false, strict = true } = {}) {
  await db.initSchema();
  const results = [];

  for (const enabled of [false, true]) {
    for (const scenario of MUTATION_SMOKE_SCENARIOS) {
      let result = null;
      let error = null;

      try {
        result = await runMutationWithMode(scenario.input, enabled);
      } catch (e) {
        error = String(e?.message || e);
      }

      if (error) {
        results.push({ mode: enabled ? 'enabled' : 'shadow', scenario: scenario.name, pass: false, error });
        continue;
      }

      const checks = [];
      if (scenario.expectMutationType) {
        checks.push({
          name: 'candidate.newSetupType',
          pass: result.candidate?.newSetupType === scenario.expectMutationType,
          got: result.candidate?.newSetupType,
          expected: scenario.expectMutationType,
        });
      }

      if (enabled) {
        if (scenario.expectRejection === true) {
          checks.push({
            name: 'mutationApplied=false',
            pass: result.mutationApplied === false,
            got: result.mutationApplied,
            expected: false,
          });
        } else if (scenario.expectMutationType) {
          checks.push({
            name: 'mutationApplied=true',
            pass: result.mutationApplied === true,
            got: result.mutationApplied,
            expected: true,
          });
        }
      } else {
        // shadow mode에서는 적용 금지
        checks.push({
          name: 'mutationApplied=false (shadow)',
          pass: result.mutationApplied === false,
          got: result.mutationApplied,
          expected: false,
        });
      }

      if (scenario.expectRejection !== undefined && !enabled) {
        checks.push({
          name: 'shadowMode=true',
          pass: result.shadowMode === true,
          got: result.shadowMode,
          expected: true,
        });
      }

      // 공통: lifecycleEvent 구조 검증
      checks.push({
        name: 'lifecycleEvent.positionScopeKey',
        pass: typeof result.lifecycleEvent?.positionScopeKey === 'string' && result.lifecycleEvent.positionScopeKey.length > 0,
        got: result.lifecycleEvent?.positionScopeKey,
        expected: 'non-empty string',
      });

      const pass = checks.every((c) => c.pass);
      const errors = checks.filter((c) => !c.pass).map((c) => `${c.name}: got ${c.got}, expected ${c.expected}`);

      results.push({
        mode: enabled ? 'enabled' : 'shadow',
        scenario: scenario.name,
        pass,
        shadowMode: result.shadowMode,
        mutationApplied: result.mutationApplied,
        candidateSetupType: result.candidate?.newSetupType ?? null,
        predictiveScore: result.candidate?.predictiveScore ?? null,
        eventType: result.lifecycleEvent?.eventType,
        rejectionReason: result.rejectionReason,
        errors,
      });
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const summary = { passed, total, pass: passed === total, results };
  if (strict) assertSmokePass(summary, '[strategy-mutation-engine-smoke]');

  if (json) return summary;

  const lines = [
    `[strategy-mutation-engine-smoke] ${passed}/${total} 통과`,
    '',
    ...results.map((r) => {
      const icon = r.pass ? '✓' : '✗';
      const out = [`  ${icon} [${r.mode}] ${r.scenario}`];
      if (r.candidateSetupType) {
        out.push(`    candidate: ${r.candidateSetupType} (predictive: ${r.predictiveScore?.toFixed(3) ?? 'n/a'})`);
      }
      out.push(`    event: ${r.eventType}, shadow: ${r.shadowMode}, applied: ${r.mutationApplied}`);
      if (r.rejectionReason) out.push(`    rejection: ${r.rejectionReason}`);
      if (r.errors.length > 0) out.push(`    오류: ${r.errors.join(' | ')}`);
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
      return runStrategyMutationEngineSmoke({ json, strict: true });
    },
    onSuccess: async (result) => {
      if (result?.text) { console.log(result.text); return; }
      console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '[strategy-mutation-engine-smoke]',
  });
}

export default { runStrategyMutationEngineSmoke };
