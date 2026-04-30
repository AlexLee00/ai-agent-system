#!/usr/bin/env node
// @ts-nocheck

import { runLunaLaunchdCutoverPreflightPackSmoke } from './runtime-luna-launchd-cutover-preflight-pack.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function main() {
  const result = await runLunaLaunchdCutoverPreflightPackSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-launchd-cutover-preflight-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-launchd-cutover-preflight-smoke 실패:',
  });
}
