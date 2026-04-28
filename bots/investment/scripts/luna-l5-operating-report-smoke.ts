#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runLunaL5OperatingReportSmoke } from './luna-l5-operating-report.ts';

async function main() {
  const result = await runLunaL5OperatingReportSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna L5 operating report smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna L5 operating report smoke 실패:',
  });
}
