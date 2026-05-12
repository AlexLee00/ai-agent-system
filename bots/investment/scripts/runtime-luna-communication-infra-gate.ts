#!/usr/bin/env node
// @ts-nocheck

import { buildLunaCommunicationInfrastructureReport } from '../shared/luna-communication-infrastructure.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function hasFlag(name) {
  return process.argv.includes(name);
}

export function runLunaCommunicationInfraGate(options = {}) {
  const report = buildLunaCommunicationInfrastructureReport(options);
  if (options.strict && !report.ok) {
    process.exitCode = 1;
  }
  return report;
}

async function main() {
  const report = runLunaCommunicationInfraGate({ strict: hasFlag('--strict') });
  console.log(JSON.stringify(report, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: 'luna communication infra gate failed:',
  });
}

export default { runLunaCommunicationInfraGate };
