#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runLunaPredictionCanaryPreflightSmoke } from './luna-prediction-canary-preflight.ts';

async function main() {
  const result = await runLunaPredictionCanaryPreflightSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna prediction canary preflight smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna prediction canary preflight smoke 실패:',
  });
}
