#!/usr/bin/env node
// @ts-nocheck
import { runLuna7DayCheckpointSmoke } from './runtime-luna-7day-checkpoint.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function main() {
  const result = await runLuna7DayCheckpointSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ luna-7day-checkpoint-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-7day-checkpoint-smoke 실패:' });
}
