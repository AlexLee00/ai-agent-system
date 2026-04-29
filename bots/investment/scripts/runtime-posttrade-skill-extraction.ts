#!/usr/bin/env node
// @ts-nocheck

import * as db from '../shared/db.ts';
import { extractPosttradeSkills } from '../shared/posttrade-skill-extractor.ts';
import { getPosttradeFeedbackRuntimeConfig } from '../shared/runtime-config.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

function parseArgs(argv = process.argv.slice(2)) {
  const daysRaw = argv.find((arg) => arg.startsWith('--days='))?.split('=')[1];
  const market = argv.find((arg) => arg.startsWith('--market='))?.split('=')[1] || 'all';
  return {
    days: Math.max(1, Number(daysRaw || 14) || 14),
    market: String(market).trim().toLowerCase() || 'all',
    dryRun: argv.includes('--dry-run'),
    force: argv.includes('--force'),
    json: argv.includes('--json'),
  };
}

export async function runPosttradeSkillExtraction(input = {}) {
  const args = { ...parseArgs([]), ...(input || {}) };
  const cfg = getPosttradeFeedbackRuntimeConfig();
  if (!args.force && cfg?.skill_extraction?.enabled !== true) {
    return {
      ok: false,
      code: 'posttrade_skill_extraction_disabled',
      mode: cfg?.mode || 'shadow',
    };
  }
  await db.initSchema();
  return extractPosttradeSkills({
    days: args.days,
    market: args.market,
    dryRun: args.dryRun,
  });
}

async function main() {
  const args = parseArgs();
  const result = await runPosttradeSkillExtraction(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else {
    if (result?.ok) console.log(`posttrade skill extraction ok — extracted=${result.extracted}`);
    else console.log(`posttrade skill extraction blocked — ${result?.code || 'unknown'}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ runtime-posttrade-skill-extraction 실패:',
  });
}

