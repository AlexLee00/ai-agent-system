// @ts-nocheck
/**
 * Phase A smoke test — adaptive-cadence-resolver
 * 5 시나리오: volatility / news / community / volume / default
 */
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  resolveAdaptiveCadence,
  ADAPTIVE_CADENCE_SMOKE_SCENARIOS,
} from '../shared/adaptive-cadence-resolver.ts';
import { assertSmokePass } from '../shared/smoke-assert.ts';

export async function runAdaptiveCadenceSmoke({ json = false, enabledOverride = null, strict = true } = {}) {
  const results = [];
  const modes = enabledOverride === null ? [false, true] : [enabledOverride === true];

  for (const enabled of modes) {
    process.env.LUNA_POSITION_ADAPTIVE_CADENCE_ENABLED = enabled ? 'true' : 'false';
    for (const scenario of ADAPTIVE_CADENCE_SMOKE_SCENARIOS) {
      const result = resolveAdaptiveCadence(scenario.input);
      const expectedTrigger = enabled ? scenario.expectedTrigger : 'default';
      const expectedOverride = enabled ? scenario.expectOverride : false;
      const triggerOk = result.triggerType === expectedTrigger;
      const overrideOk = result.overrideApplied === expectedOverride;
      const pass = triggerOk && overrideOk;

      results.push({
        mode: enabled ? 'enabled' : 'shadow',
        scenario: scenario.name,
        pass,
        triggerType: result.triggerType,
        expectedTrigger,
        cadenceMs: result.cadenceMs,
        overrideApplied: result.overrideApplied,
        expectedOverride,
        reason: result.reason,
        errors: [
          !triggerOk && `triggerType 불일치: ${result.triggerType} ≠ ${expectedTrigger}`,
          !overrideOk && `overrideApplied 불일치: ${result.overrideApplied} ≠ ${expectedOverride}`,
        ].filter(Boolean),
      });
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const summary = { passed, total, pass: passed === total, results };
  if (strict) assertSmokePass(summary, '[adaptive-cadence-smoke]');

  if (json) return summary;

  const lines = [
    `[adaptive-cadence-smoke] ${passed}/${total} 통과`,
    '',
    ...results.map((r) => {
      const icon = r.pass ? '✓' : '✗';
      const lines2 = [`  ${icon} [${r.mode}] ${r.scenario}`];
      lines2.push(`    cadenceMs: ${r.cadenceMs / 1000}s, triggerType: ${r.triggerType}, override: ${r.overrideApplied}`);
      if (r.errors.length > 0) lines2.push(`    오류: ${r.errors.join(', ')}`);
      return lines2.join('\n');
    }),
  ];
  return { ...summary, text: lines.join('\n') };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const args = process.argv.slice(2);
      const json = args.includes('--json');
      // --enabled 플래그로 kill switch 강제 활성화 테스트
      const enabledOverride = args.includes('--enabled') ? true : args.includes('--disabled') ? false : null;
      return runAdaptiveCadenceSmoke({ json, enabledOverride, strict: true });
    },
    onSuccess: async (result) => {
      if (result?.text) { console.log(result.text); return; }
      console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '[adaptive-cadence-smoke]',
  });
}

export default { runAdaptiveCadenceSmoke };
