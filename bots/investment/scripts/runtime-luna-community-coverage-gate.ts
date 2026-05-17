#!/usr/bin/env node
// @ts-nocheck

import { fetchLunaCommunityCoverageGate } from '../shared/luna-community-coverage-gate.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

export async function runLunaCommunityCoverageGate(options: any = {}) {
  const report = await fetchLunaCommunityCoverageGate({
    hours: Number(options.hours || 24),
  });
  if (options.strict === true && !report.ok) process.exitCode = 1;
  return report;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaCommunityCoverageGate({
      hours: Number(argValue('hours', 24)),
      strict: hasFlag('strict'),
    }),
    onSuccess: async (result) => {
      if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`[luna-community-coverage] ok=${result.ok} pass=${result.summary.passMarkets}/${result.summary.totalMarkets} events=${result.summary.totalEvents} blockers=${result.blockers.length}`);
      }
    },
    errorPrefix: 'runtime-luna-community-coverage-gate failed:',
  });
}
