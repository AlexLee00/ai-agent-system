#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runLunaCanaryOperatorSmoke } from './luna-canary-operator.ts';

async function main() {
  const result = await runLunaCanaryOperatorSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna canary operator smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna canary operator smoke 실패:',
  });
}
