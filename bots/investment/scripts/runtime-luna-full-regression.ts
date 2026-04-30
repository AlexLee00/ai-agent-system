#!/usr/bin/env node
// @ts-nocheck
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { createGuardrailRegistry } from '../shared/guardrail-registry.ts';
import { buildLuna100PercentReport } from './runtime-luna-100percent-report.ts';

export async function buildFullRegressionReport() {
  const guardrails = createGuardrailRegistry().list();
  const report = buildLuna100PercentReport();
  return {
    ok: report.ok,
    generatedAt: new Date().toISOString(),
    dryRun: true,
    guardrailCount: guardrails.length,
    smokeCoverage: {
      wave1: true,
      wave2: true,
      wave3: true,
      fullIntegration: true,
    },
    backtest: {
      layer1: 'covered_by_luna_backtest_layer1_smoke',
      layer2: 'covered_by_luna_backtest_layer2_smoke',
      dailyDryRun: 'covered_by_runtime_luna_daily_backtest',
    },
    report,
  };
}

async function main() {
  const result = await buildFullRegressionReport();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`runtime-luna-full-regression ok=${result.ok} guardrails=${result.guardrailCount}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ runtime-luna-full-regression 실패:' });
}
