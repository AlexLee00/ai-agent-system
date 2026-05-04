#!/usr/bin/env node
// @ts-nocheck
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { buildLunaAgentNormalizationReport } from '../shared/luna-agent-normalization.ts';

async function main() {
  const report = buildLunaAgentNormalizationReport();
  if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(`${report.status} ok=${report.ok} agents=${report.summary.canonicalYamlAgents} skills=${report.summary.skillCount}`);
  if (!report.ok) throw new Error(`${report.status}:${report.blockers.join(',')}`);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'runtime-luna-agent-normalization-report failed:' });
}
