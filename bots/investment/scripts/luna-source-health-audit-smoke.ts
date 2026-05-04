#!/usr/bin/env node
// @ts-nocheck
import assert from 'node:assert/strict';
import { buildLunaSourceHealthAudit } from '../shared/luna-source-health-audit.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

export async function runSmoke() {
  const report = buildLunaSourceHealthAudit();
  assert.equal(report.ok, true);
  assert.equal(report.summary.criticalBudgets.every((item) => item.ok), true);
  assert.equal(report.summary.marketdataFallbackPolicy.every((item) => item.importsPolicy && item.usesPolicy), true);
  assert.ok(report.summary.sourceFiles > 100);
  return report;
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-source-health-audit-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'luna-source-health-audit-smoke failed:' });
}
