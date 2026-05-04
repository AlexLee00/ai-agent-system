#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaNormalizationRefactorGuardrailMasterReport } from '../shared/luna-normalization-refactor-guardrail-master.ts';

export async function runLunaNormalizationRefactorGuardrailMasterSmoke() {
  const report = buildLunaNormalizationRefactorGuardrailMasterReport();
  assert.equal(report.ok, true, `master report blocked: ${JSON.stringify(report.blockers)}`);
  assert.equal(report.summary.phaseStatuses.psi, 'complete');
  assert.equal(report.summary.phaseStatuses.refactor, 'complete');
  assert.equal(report.summary.phaseStatuses.guardrail, 'complete');
  assert.equal(report.summary.phaseStatuses.technicalAnalysis, 'complete');
  assert.equal(report.summary.coreAgentCount, 19);
  assert.equal(report.summary.shadowExtensionCount, 1);
  assert.ok(report.phases.psi.summary.elixirShadowAgents >= 5, 'five Elixir shadow agents registered');
  assert.ok(report.summary.totalGuardrails >= 50, `guardrails >=50, got ${report.summary.totalGuardrails}`);
  assert.ok(report.summary.taFilesReady >= 10, `TA files >=10, got ${report.summary.taFilesReady}`);
  return { ok: true, status: report.status, summary: report.summary };
}

async function main() {
  const result = await runLunaNormalizationRefactorGuardrailMasterSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`luna-normalization-refactor-guardrail-master-smoke ok guardrails=${result.summary.totalGuardrails}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-normalization-refactor-guardrail-master-smoke failed:' });
}
