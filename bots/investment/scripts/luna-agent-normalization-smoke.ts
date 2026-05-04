#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaAgentNormalizationReport } from '../shared/luna-agent-normalization.ts';

export async function runSmoke() {
  const report = buildLunaAgentNormalizationReport();
  assert.equal(report.ok, true, `normalization report must be complete: ${JSON.stringify(report.blockers)}`);
  assert.equal(report.summary.coreAgentCount, 19);
  assert.equal(report.summary.shadowExtensionCount, 1);
  assert.ok(report.summary.skillCount >= 44, `expected skill registry coverage >=44, got ${report.summary.skillCount}`);
  assert.equal(report.summary.mcpNormalized, true);
  assert.equal(report.summary.elixirStockFlowSweeperReady, true);
  assert.equal(report.summary.collaborationMatrixOk, true);
  assert.equal(report.summary.executableFlows, 4);
  return {
    ok: true,
    status: report.status,
    summary: report.summary,
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log(`luna-agent-normalization-smoke ok agents=${result.summary.canonicalYamlAgents} skills=${result.summary.skillCount}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-agent-normalization-smoke failed:' });
}
