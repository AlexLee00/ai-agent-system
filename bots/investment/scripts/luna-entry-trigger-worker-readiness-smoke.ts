#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runLunaEntryTriggerWorkerReadinessSmoke } from './luna-entry-trigger-worker-readiness.ts';

async function main() {
  const result = await runLunaEntryTriggerWorkerReadinessSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna entry-trigger worker readiness smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna entry-trigger worker readiness smoke 실패:',
  });
}
