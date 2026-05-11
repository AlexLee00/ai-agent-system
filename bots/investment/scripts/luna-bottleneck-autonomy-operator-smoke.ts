#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runLunaBottleneckAutonomyOperatorSmoke } from './runtime-luna-bottleneck-autonomy-operator.ts';

async function main() {
  const result = await runLunaBottleneckAutonomyOperatorSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna bottleneck autonomy operator smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: '❌ luna-bottleneck-autonomy-operator-smoke 실패:' });
}
