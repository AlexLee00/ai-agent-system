#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import { runLunaReconcileEvidencePackSmoke } from './runtime-luna-reconcile-evidence-pack.ts';

async function main() {
  const result = await runLunaReconcileEvidencePackSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna reconcile evidence pack smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna reconcile evidence pack smoke 실패:',
  });
}
