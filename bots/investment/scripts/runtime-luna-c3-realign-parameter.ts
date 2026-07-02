#!/usr/bin/env node
// @ts-nocheck

import { applyC3ParameterPlan } from '../shared/luna-c3-realign.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

export async function runLunaC3RealignParameterRuntime(options = {}) {
  const apply = options.apply === true;
  return applyC3ParameterPlan({
    apply,
    queryFn: options.queryFn,
    runFn: options.runFn,
    env: options.env || process.env,
  });
}

async function main() {
  const result = await runLunaC3RealignParameterRuntime({ apply: hasFlag('apply') });
  if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
  else console.log(result.applied ? 'c3 realign parameter applied' : 'c3 realign parameter dry-run');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({ run: main, errorPrefix: 'runtime-luna-c3-realign-parameter failed:' });
}
