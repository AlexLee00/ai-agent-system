#!/usr/bin/env node
// @ts-nocheck
import { runLuna7DayNaturalCheckpointSmoke } from './runtime-luna-7day-natural-checkpoint.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function main() {
  const result = await runLuna7DayNaturalCheckpointSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ luna-7day-natural-checkpoint-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-7day-natural-checkpoint-smoke 실패:',
  });
}
