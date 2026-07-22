#!/usr/bin/env tsx

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runRoutingOutcomeBackfill } from '../bots/hub/scripts/llm-routing-outcome-backfill.ts';
import { buildDirectiveSemanticDedupeReport } from '../bots/sigma/scripts/runtime-sigma-vault-dedupe.ts';
import { runLunaNextbarShadowDaily } from '../bots/investment/scripts/runtime-luna-nextbar-shadow-daily.ts';

async function normalizedDryRunOutputs() {
  const hub = await runRoutingOutcomeBackfill({
    argv: [],
    queryReadonly: async () => [],
    writeArtifacts: async () => ({
      summary: 'SUMMARY',
      pairs: 'PAIRS',
      rollback_snapshot: 'ROLLBACK',
    }),
  });
  const sigma = await buildDirectiveSemanticDedupeReport({ rows: [], write: false });
  delete sigma.generatedAt;
  const nextbar = await runLunaNextbarShadowDaily({}, {});
  return { hub, sigma, nextbar };
}

async function main() {
  const actual = await normalizedDryRunOutputs();
  if (process.argv.includes('--emit')) {
    process.stdout.write(`${JSON.stringify(actual, null, 2)}\n`);
    return;
  }
  const expected = JSON.parse(fs.readFileSync(
    new URL('./fixtures/task-0094-runner-dry-run-before.json', import.meta.url),
    'utf8',
  ));
  assert.deepEqual(actual, expected);
  console.log(JSON.stringify({
    ok: true,
    diff: 0,
    liveMutation: false,
    planSha256: {
      hub: actual.hub.plan_sha256,
      sigma: actual.sigma.planSha,
      nextbar: null,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error('write-action-confirm runner equivalence smoke: FAIL');
  console.error(error);
  process.exitCode = 1;
});
