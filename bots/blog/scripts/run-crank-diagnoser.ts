#!/usr/bin/env node
// @ts-nocheck
'use strict';

const { runCrankDiagnoser } = require('../lib/crank-diagnoser.ts');

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function boundedNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

async function main() {
  const result = await runCrankDiagnoser({
    limit: boundedNumber(argValue('limit', 10), 10, 1, 100),
    days: boundedNumber(argValue('days', 30), 30, 1, 365),
    write: hasFlag('write'),
    useLlm: hasFlag('llm'),
  });
  if (hasFlag('json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`[crank-diagnoser] dryRun=${result.dryRun} rows=${result.rows} lessons=${result.lessons.length} inserted=${result.writeResult?.inserted || 0}`);
  for (const lesson of result.lessons.slice(0, 10)) {
    console.log(`- ${lesson.axis}: ${lesson.lesson}`);
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  process.exit(1);
});
