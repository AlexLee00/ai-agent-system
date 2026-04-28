#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { computeDynamicTrail } from '../shared/dynamic-trail-engine.ts';
import { assertSmokePass } from '../shared/smoke-assert.ts';

const SCENARIOS = [
  { name: 'atr_long', input: { method: 'atr', side: 'long', close: 100, atr: 2.5 }, expectReason: 'trail_atr' },
  { name: 'chandelier_long', input: { method: 'chandelier', side: 'long', close: 100, atr: 2, highestHigh: 106 }, expectReason: 'trail_chandelier' },
  { name: 'sar_long', input: { method: 'sar', side: 'long', close: 100, sar: 97.2 }, expectReason: 'trail_sar' },
  { name: 'vwap_long', input: { method: 'vwap', side: 'long', close: 100, vwap: 99.1, atr: 1.8 }, expectReason: 'trail_vwap' },
  { name: 'previous_stop_breach', input: { method: 'atr', side: 'long', close: 96, atr: 2, previousStopPrice: 98 }, expectReason: 'trail_atr', expectBreached: true },
];

export async function runDynamicTrailEngineSmoke({ json = false, strict = true } = {}) {
  const saved = process.env.LUNA_DYNAMIC_TRAIL_ENGINE_ENABLED;
  process.env.LUNA_DYNAMIC_TRAIL_ENGINE_ENABLED = 'true';
  const results = [];
  try {
    for (const scenario of SCENARIOS) {
      const output = computeDynamicTrail(scenario.input);
      const pass = output.reasonCode === scenario.expectReason
        && Number.isFinite(Number(output.stopPrice))
        && (scenario.expectBreached == null || output.breached === scenario.expectBreached);
      results.push({
        scenario: scenario.name,
        pass,
        reasonCode: output.reasonCode,
        stopPrice: output.stopPrice,
        previousStopPrice: output.previousStopPrice,
        breached: output.breached,
        breachReasonCode: output.breachReasonCode,
        method: output.method,
        errors: [
          output.reasonCode !== scenario.expectReason
            ? `reason mismatch ${output.reasonCode} != ${scenario.expectReason}`
            : null,
          !Number.isFinite(Number(output.stopPrice))
            ? `invalid stopPrice ${output.stopPrice}`
            : null,
          scenario.expectBreached != null && output.breached !== scenario.expectBreached
            ? `breach mismatch ${output.breached} != ${scenario.expectBreached}`
            : null,
        ].filter(Boolean),
      });
    }
  } finally {
    if (saved === undefined) delete process.env.LUNA_DYNAMIC_TRAIL_ENGINE_ENABLED;
    else process.env.LUNA_DYNAMIC_TRAIL_ENGINE_ENABLED = saved;
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  const summary = { pass: passed === total, passed, total, results };
  if (strict) assertSmokePass(summary, '[dynamic-trail-engine-smoke]');
  if (json) return summary;
  return {
    ...summary,
    text: [
      `[dynamic-trail-engine-smoke] ${passed}/${total} 통과`,
      ...results.map((item) => `${item.pass ? '✓' : '✗'} ${item.scenario} -> ${item.reasonCode} (stop=${item.stopPrice})`),
    ].join('\n'),
  };
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => {
      const json = process.argv.includes('--json');
      return runDynamicTrailEngineSmoke({ json, strict: true });
    },
    onSuccess: async (result) => {
      if (result?.text) console.log(result.text);
      else console.log(JSON.stringify(result, null, 2));
    },
    errorPrefix: '[dynamic-trail-engine-smoke]',
  });
}
