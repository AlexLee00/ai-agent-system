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

export async function runAdaptiveCadenceSmoke({ json = false, enabledOverride = null } = {}) {
  const results = [];

  for (const scenario of ADAPTIVE_CADENCE_SMOKE_SCENARIOS) {
    // kill switch override for testing
    if (enabledOverride !== null) {
      process.env.LUNA_POSITION_ADAPTIVE_CADENCE_ENABLED = enabledOverride ? 'true' : 'false';
    }

    const result = resolveAdaptiveCadence(scenario.input);
    const triggerOk = result.triggerType === scenario.expectedTrigger;
    const overrideOk = result.overrideApplied === scenario.expectOverride;
    const pass = triggerOk && overrideOk;

    results.push({
      scenario: scenario.name,
      pass,
      triggerType: result.triggerType,
      expectedTrigger: scenario.expectedTrigger,
      cadenceMs: result.cadenceMs,
      overrideApplied: result.overrideApplied,
      reason: result.reason,
      errors: [
        !triggerOk && `triggerType 불일치: ${result.triggerType} ≠ ${scenario.expectedTrigger}`,
        !overrideOk && `overrideApplied 불일치: ${result.overrideApplied} ≠ ${scenario.expectOverride}`,
      ].filter(Boolean),
    });
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const summary = { passed, total, pass: passed === total, results };

  if (json) return summary;

  const lines = [
    `[adaptive-cadence-smoke] ${passed}/${total} 통과`,
    '',
    ...results.map((r) => {
      const icon = r.pass ? '✓' : '✗';
      const lines2 = [`  ${icon} ${r.scenario}`];
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
      return runAdaptiveCadenceSmoke({ json, enabledOverride });
    },
    onSuccess: async (result) => {
      if (result?.text) { console.log(result.text); return; }
      console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '[adaptive-cadence-smoke]',
  });
}

export default { runAdaptiveCadenceSmoke };
