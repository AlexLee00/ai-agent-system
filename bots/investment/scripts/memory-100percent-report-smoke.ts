#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { buildMemory100PercentReport, renderMemory100PercentReport } from './runtime-memory-100percent-report.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const agents = Array.from({ length: 19 }, (_, index) => ({
    name: index === 0 ? 'kairos' : `agent-${index}`,
    validation: { ok: true },
  }));
  const report = buildMemory100PercentReport({
    agents,
    checkpoint: { ok: true, status: 'pending_observation', pendingObservation: ['7day natural data pending'], evidence: { fired: 1 } },
    busStats: { ok: true, stats: { window7dMessages: 10, window24hMessages: 2 } },
    voyager: { ok: true, status: 'pending_observation', productionSkillPromoted: false, pendingReason: 'insufficient_natural_data' },
    failedReflexion: { triggerReady: true, backfillDryRun: true },
  });
  assert.equal(report.codeComplete, true);
  assert.equal(report.operationalStatus, 'code_complete_operational_pending');
  assert.equal(report.blockers.length, 0);
  const markdown = renderMemory100PercentReport(report);
  assert.ok(markdown.includes('Phase ξ Checks'));
  assert.ok(markdown.includes('ξ3_failed_reflexion'));
  return { ok: true, report, markdownLength: markdown.length };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ memory-100percent-report-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ memory-100percent-report-smoke 실패:' });
}
