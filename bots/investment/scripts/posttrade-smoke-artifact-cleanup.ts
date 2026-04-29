#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  return {
    apply: argv.includes('--apply'),
    json: argv.includes('--json'),
  };
}

export async function runPosttradeSmokeArtifactCleanup(input = {}) {
  const args = { ...parseArgs([]), ...(input || {}) };
  await db.initSchema();
  const result = await db.cleanupPosttradeSmokeArtifacts({ apply: args.apply });
  return {
    ok: true,
    status: args.apply ? 'posttrade_smoke_artifacts_cleaned' : 'posttrade_smoke_artifacts_preview',
    ...result,
  };
}

async function main() {
  const args = parseArgs();
  const result = await runPosttradeSmokeArtifactCleanup(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`${result.status} — feedback=${result.feedbackToActionRows} skills=${result.posttradeSkills} suggestions=${result.suggestionLogs} knowledge=${result.knowledgeRows}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ posttrade-smoke-artifact-cleanup 실패:',
  });
}
