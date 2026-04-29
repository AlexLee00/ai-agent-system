#!/usr/bin/env node
// @ts-nocheck

import { runPosttradeFeedbackWorker } from './runtime-posttrade-feedback-worker.ts';
import { buildPosttradeFeedbackDoctor } from './runtime-posttrade-feedback-doctor.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const limitRaw = argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1];
  const market = argv.find((arg) => arg.startsWith('--market='))?.split('=')[1] || 'all';
  return {
    json: argv.includes('--json'),
    limit: Math.max(1, Number(limitRaw || 3) || 3),
    market: String(market).trim().toLowerCase() || 'all',
  };
}

export async function bootstrapPosttradeFeedbackHeartbeat(input = {}) {
  const args = { ...parseArgs([]), ...(input || {}) };
  const before = await buildPosttradeFeedbackDoctor({ strict: false });
  const worker = await runPosttradeFeedbackWorker({
    once: true,
    force: true,
    dryRun: true,
    limit: args.limit,
    market: args.market,
  });
  const after = await buildPosttradeFeedbackDoctor({ strict: true });
  const heartbeat = (after.checks || []).find((item) => item.name === 'posttrade_worker_heartbeat') || null;
  return {
    ok: worker?.ok === true && after?.ok === true,
    status: worker?.ok === true && after?.ok === true
      ? 'posttrade_heartbeat_bootstrapped'
      : 'posttrade_heartbeat_bootstrap_failed',
    beforeWarnings: before?.warnings || [],
    worker,
    heartbeat,
    afterFailures: after?.failures || [],
    afterWarnings: after?.warnings || [],
  };
}

async function main() {
  const args = parseArgs();
  const result = await bootstrapPosttradeFeedbackHeartbeat(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`${result.status} — warnings=${result.afterWarnings.length}`);
  if (result.ok !== true) throw new Error(result.status);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-posttrade-feedback-heartbeat-bootstrap 실패:',
  });
}
