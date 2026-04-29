#!/usr/bin/env node
// @ts-nocheck

import { buildPosttradeFeedbackDoctor } from './runtime-posttrade-feedback-doctor.ts';
import { runPosttradeFeedbackWorker } from './runtime-posttrade-feedback-worker.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const limitRaw = argv.find((arg) => arg.startsWith('--limit='))?.split('=')[1];
  const market = argv.find((arg) => arg.startsWith('--market='))?.split('=')[1] || 'all';
  return {
    json: argv.includes('--json'),
    strict: argv.includes('--strict'),
    limit: Math.max(1, Number(limitRaw || 3) || 3),
    market: String(market).trim().toLowerCase() || 'all',
  };
}

export async function runPosttradeFeedbackReadiness(input = {}) {
  const args = { ...parseArgs([]), ...(input || {}) };
  const doctor = await buildPosttradeFeedbackDoctor({ strict: args.strict });
  const workerDryRun = await runPosttradeFeedbackWorker({
    once: true,
    force: true,
    dryRun: true,
    limit: args.limit,
    market: args.market,
    heartbeatPath: '',
  }).catch((error) => ({
    ok: false,
    code: 'posttrade_worker_dry_run_failed',
    error: String(error?.message || error || 'unknown'),
  }));

  const blockers = [];
  for (const failure of doctor.failures || []) {
    blockers.push(`doctor:${failure.name}:${failure.reason || 'failed'}`);
  }
  if (workerDryRun?.ok !== true) {
    blockers.push(`worker:${workerDryRun?.code || 'dry_run_failed'}`);
  }
  if (workerDryRun?.learning?.dashboard?.ok !== true) {
    blockers.push(`dashboard:${workerDryRun?.learning?.dashboard?.code || 'not_ready'}`);
  }
  if (workerDryRun?.learning?.skillExtraction?.ok !== true) {
    blockers.push(`skill_extraction:${workerDryRun?.learning?.skillExtraction?.code || 'not_ready'}`);
  }

  return {
    ok: blockers.length === 0,
    generatedAt: new Date().toISOString(),
    market: args.market,
    limit: args.limit,
    blockers,
    doctor,
    workerDryRun,
    nextAction: blockers.length === 0
      ? 'posttrade_worker_can_be_enabled_in_shadow'
      : 'resolve_blockers_before_enabling_worker',
  };
}

async function main() {
  const args = parseArgs();
  const result = await runPosttradeFeedbackReadiness(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`posttrade readiness ${result.ok ? 'ok' : 'blocked'} — blockers=${result.blockers.length}`);
  }
  if (!result.ok) {
    throw new Error(`posttrade_readiness_blocked blockers=${result.blockers.join(',') || 'unknown'}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-posttrade-feedback-readiness 실패:',
  });
}
