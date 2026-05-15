#!/usr/bin/env node
// @ts-nocheck

import { fetchLunaCommunitySourceQualityAudit } from '../shared/luna-community-source-quality.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

export async function runLunaCommunitySourceQuality(options: any = {}) {
  const report = await fetchLunaCommunitySourceQualityAudit({
    days: Number(options.days || 7),
    minEvents: Number(options.minEvents || 3),
    market: options.market || null,
  });
  if (options.strict === true && !report.ok) process.exitCode = 1;
  return report;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runLunaCommunitySourceQuality({
      days: Number(argValue('days', 7)),
      minEvents: Number(argValue('min-events', 3)),
      market: argValue('market', null),
      strict: hasFlag('strict'),
    }),
    onSuccess: async (result) => {
      if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`[luna-community-source-quality] ok=${result.ok} sources=${result.totalSources} warnings=${result.warnings.length} blockers=${result.blockers.length}`);
      }
    },
    errorPrefix: 'runtime-luna-community-source-quality failed:',
  });
}
