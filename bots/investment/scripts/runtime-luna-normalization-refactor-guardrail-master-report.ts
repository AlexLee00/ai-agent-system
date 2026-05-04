#!/usr/bin/env node
// @ts-nocheck
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaNormalizationRefactorGuardrailMasterReport } from '../shared/luna-normalization-refactor-guardrail-master.ts';

async function main() {
  const report = buildLunaNormalizationRefactorGuardrailMasterReport();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else {
    const phases = Object.entries(report.summary.phaseStatuses)
      .map(([phase, status]) => `${phase}=${status}`)
      .join(' ');
    console.log(`${report.status} ok=${report.ok} ${phases}`);
  }
  if (!report.ok) throw new Error(`${report.status}:${report.blockers.join(',')}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'runtime-luna-normalization-refactor-guardrail-master-report failed:' });
}
