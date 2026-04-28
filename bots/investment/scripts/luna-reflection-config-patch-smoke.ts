#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runLunaReflectionConfigPatchSmoke } from './luna-reflection-config-patch.ts';

async function main() {
  const result = runLunaReflectionConfigPatchSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna reflection config patch smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna reflection config patch smoke 실패:',
  });
}
