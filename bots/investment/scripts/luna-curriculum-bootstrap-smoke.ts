#!/usr/bin/env node
// @ts-nocheck

import { runLunaCurriculumBootstrapSmoke } from './runtime-luna-curriculum-bootstrap.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function main() {
  const result = await runLunaCurriculumBootstrapSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('luna-curriculum-bootstrap-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ luna-curriculum-bootstrap-smoke 실패:',
  });
}
