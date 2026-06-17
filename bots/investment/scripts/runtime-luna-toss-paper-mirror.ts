#!/usr/bin/env node
// @ts-nocheck

import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';
import {
  LUNA_TOSS_PAPER_MIRROR_CONFIRM,
  runTossPaperMirror,
} from '../shared/luna-toss-paper-mirror.ts';

function hasFlag(name: string) {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export async function runRuntimeLunaTossPaperMirror(options: any = {}, deps: any = {}) {
  return runTossPaperMirror(options, deps);
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: async () => runRuntimeLunaTossPaperMirror({
      market: argValue('market', 'domestic'),
      limit: Number(argValue('limit', 20)),
      dryRun: hasFlag('dry-run') || !hasFlag('apply'),
      apply: hasFlag('apply'),
      confirm: argValue('confirm', ''),
      stage: argValue('stage', null),
      json: hasFlag('json'),
    }),
    onSuccess: async (result) => {
      if (hasFlag('json')) console.log(JSON.stringify(result, null, 2));
      else {
        console.log(`[luna-toss-paper-mirror] stage=${result.stage} evaluated=${result.evaluated} written=${result.written} placed=${result.placed}`);
        if (result.dryRun) console.log(`[luna-toss-paper-mirror] dry-run; apply requires --apply --confirm=${LUNA_TOSS_PAPER_MIRROR_CONFIRM}`);
      }
    },
    errorPrefix: 'runtime-luna-toss-paper-mirror error:',
  });
}
