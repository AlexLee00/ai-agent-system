#!/usr/bin/env node
// @ts-nocheck
import { runVoyagerNaturalAccelerationSmoke } from './runtime-voyager-natural-acceleration.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function main() {
  const result = await runVoyagerNaturalAccelerationSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('✅ voyager-natural-acceleration-smoke');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ voyager-natural-acceleration-smoke 실패:',
  });
}
