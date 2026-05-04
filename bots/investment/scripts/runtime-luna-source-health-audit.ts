#!/usr/bin/env node
// @ts-nocheck
import { buildLunaSourceHealthAudit } from '../shared/luna-source-health-audit.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function main() {
  const report = buildLunaSourceHealthAudit();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(report.ok ? 'luna source health guarded' : `luna source health blocked: ${report.blockers.join(', ')}`);
  if (!report.ok) process.exitCode = 1;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'runtime-luna-source-health-audit failed:' });
}
