#!/usr/bin/env node
// @ts-nocheck

import { buildAgentLlmRouteQualityReport } from '../shared/agent-memory-operational-policy.ts';
import { publishAlert } from '../shared/alert-publisher.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    days: Math.max(1, Number(argv.find((arg) => arg.startsWith('--days='))?.split('=')[1] || 3) || 3),
    market: argv.find((arg) => arg.startsWith('--market='))?.split('=')[1] || 'all',
    minCalls: Math.max(1, Number(argv.find((arg) => arg.startsWith('--min-calls='))?.split('=')[1] || 3) || 3),
    dryRun: argv.includes('--dry-run'),
    json: argv.includes('--json'),
  };
}

export async function runAgentMemoryRouteQuality(args = {}) {
  const report = await buildAgentLlmRouteQualityReport({
    days: args.days ?? 3,
    market: args.market || 'all',
    minCalls: args.minCalls ?? 3,
  });

  if (!args.dryRun && report.suggestions.length > 0) {
    await publishAlert({
      from_bot: 'luna',
      event_type: 'agent_memory_route_quality',
      alert_level: report.ok ? 1 : 2,
      message: [
        '🧠 Luna Agent LLM route 품질 점검',
        `status=${report.status}`,
        `suggestions=${report.suggestions.length}`,
        `market=${report.market}, days=${report.days}`,
      ].join('\n'),
      payload: report,
    }).catch(() => false);
  }

  return report;
}

async function main() {
  const args = parseArgs();
  const report = await runAgentMemoryRouteQuality(args);
  if (args.json) console.log(JSON.stringify(report, null, 2));
  else console.log(`${report.status} suggestions=${report.suggestions.length}`);
  return report;
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-agent-memory-route-quality 실패:',
  });
}
