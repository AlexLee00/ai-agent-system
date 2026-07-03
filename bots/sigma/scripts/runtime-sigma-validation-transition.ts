#!/usr/bin/env node
// @ts-nocheck

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyValidationTransitionPlan,
  buildValidationTransitionReport,
} from '../vault/validation-transition.ts';
import { buildWikiHealthReport } from './wiki-health-check.ts';

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  return {
    json: argv.includes('--json'),
    write,
    dryRun: !write || argv.includes('--dry-run') || !argv.includes('--no-dry-run'),
    noDb: argv.includes('--no-db'),
    includeWikiHealth: !argv.includes('--no-wiki-health'),
    limit: Math.max(1, Math.min(1000, Number(argValue('--limit', 100)) || 100)),
  };
}

async function main() {
  const args = parseArgs();
  const wikiHealth = args.includeWikiHealth ? buildWikiHealthReport() : null;
  const report = args.noDb
    ? await buildValidationTransitionReport({ dueRows: [], evidenceRows: [], wikiHealth, dryRun: args.dryRun, limit: args.limit })
    : await buildValidationTransitionReport({ wikiHealth, dryRun: args.dryRun, limit: args.limit });
  let applyResult = null;
  if (args.write && !args.dryRun) {
    applyResult = await applyValidationTransitionPlan(report.plan);
  }
  const liveMutation = Boolean(applyResult && Number(applyResult.count || 0) > 0);
  const output = { ...report, liveMutation, applyResult };
  if (args.json) console.log(JSON.stringify(output, null, 2));
  else console.log(`[sigma-validation-transition] due=${report.counts.due} applicable=${report.counts.applicable} dryRun=${report.dryRun}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[sigma-validation-transition] failed: ${error?.message || error}`);
    process.exit(1);
  });
}
