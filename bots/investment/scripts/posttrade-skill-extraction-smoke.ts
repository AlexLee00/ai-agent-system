#!/usr/bin/env node
// @ts-nocheck

import assert from 'node:assert/strict';
import { runPosttradeSkillExtraction } from './runtime-posttrade-skill-extraction.ts';
import { isDirectExecution, runCliMain } from '../shared/cli-runtime.ts';

async function runSmoke() {
  const previous = process.env.LUNA_VOYAGER_SKILL_LIBRARY_ENABLED;
  process.env.LUNA_VOYAGER_SKILL_LIBRARY_ENABLED = 'false';
  const blocked = await runPosttradeSkillExtraction({
    dryRun: true,
    days: 7,
    market: 'all',
  });
  if (previous === undefined) delete process.env.LUNA_VOYAGER_SKILL_LIBRARY_ENABLED;
  else process.env.LUNA_VOYAGER_SKILL_LIBRARY_ENABLED = previous;
  assert.equal(blocked?.ok, false, 'skill extraction disabled by default');
  assert.equal(blocked?.code, 'posttrade_skill_extraction_disabled');

  const forced = await runPosttradeSkillExtraction({
    dryRun: true,
    force: true,
    days: 7,
    market: 'all',
  });
  assert.equal(forced?.ok, true, 'forced run succeeds');
  assert.ok(Number.isFinite(Number(forced?.candidates ?? 0)), 'has candidates count');
  assert.ok(Number.isFinite(Number(forced?.extracted ?? 0)), 'has extracted count');

  return {
    ok: true,
    blocked,
    forced: {
      market: forced?.market,
      candidates: forced?.candidates ?? 0,
      extracted: forced?.extracted ?? 0,
    },
  };
}

async function main() {
  const result = await runSmoke();
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else console.log('posttrade-skill-extraction-smoke ok');
}

if (isDirectExecution(import.meta.url)) {
  await runCliMain({
    run: main,
    errorPrefix: '❌ posttrade-skill-extraction-smoke 실패:',
  });
}
